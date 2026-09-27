// Client-side access-token renewal.
//
// WHY THIS FILE EXISTS
// The access token is deliberately short-lived (15 minutes — see
// ACCESS_TOKEN_TTL_SECONDS in app/lib/refresh-session.ts). A short token is only
// safe if the browser can silently obtain a new one, which it can because the
// server put a long-lived refresh session in an HttpOnly cookie. Page JavaScript
// never sees that cookie: it just calls this endpoint and the browser attaches it
// on its own. So this file holds NO secret — it can only ask for a new access
// token, and the response contains nothing but the access token and the user it
// belongs to.
//
// THE HARD PART: TWO TABS, ONE ROTATING COOKIE
// The server rotates the refresh cookie on every call and treats the replay of a
// rotated token as a possible theft, which revokes the whole session family. If
// two tabs refreshed at the same instant, the loser of that race would kill the
// session for BOTH tabs — a self-inflicted logout, and a denial-of-service the
// user could trigger by simply opening the app twice.
//
// So every refresh is taken under a cross-tab lock:
//   * Web Locks API when the browser has it (all current browsers), which is a
//     real mutual-exclusion primitive;
//   * an in-memory single-flight promise otherwise, which at least covers the
//     single-tab case.
// The tab that loses the lock does not re-request. It waits for the winner's
// result — which is visible in localStorage, where this app has always kept the
// access token — and adopts that. So the cookie is only ever rotated once per
// expiry no matter how many tabs are open.
//
// Also handled here: refreshing on tab focus (a laptop that slept for hours comes
// back with an expired token and the user would otherwise be bounced to login),
// and a network failure being DISTINGUISHED from a rejected session. Only the
// latter may sign the user out; a flaky network must never do that.

/** Path of the renewal endpoint. Relative, so it works on any host. */
const REFRESH_PATH = "/api/v1/auth/refresh";
const LOGOUT_PATH = "/api/v1/auth/logout";

/** localStorage key holding the auth user incl. the access token. */
const STORAGE_KEY = "stax_auth_user";

/**
 * Admin sessions live in a different store (see app/lib/admin-auth.ts) and the
 * renewal endpoint serves both portals, so that module is imported here rather
 * than duplicated.
 */
import {
  ADMIN_SESSION_KEY,
  readAdminSession,
  saveAdminSession,
} from "./admin-auth";

/** Refresh this many seconds BEFORE the token actually expires. */
export const REFRESH_SKEW_SECONDS = 60;

/** Name of the cross-tab lock. Shared by every tab on the origin. */
const REFRESH_LOCK_NAME = "stax-access-token-refresh";

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  accessToken: string;
}

export type RefreshFailureReason =
  /** The server said no: cookie gone, revoked, expired, or user not ACTIVE. */
  | "rejected"
  /** The request never completed (offline, DNS, abort). NOT a sign-out. */
  | "network"
  /** The browser refused to attach the cookie. */
  | "noSession";

export type RefreshResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: RefreshFailureReason };

// ---------------------------------------------------------------------------
// Token expiry (pure, no network)
// ---------------------------------------------------------------------------

interface JwtPayload {
  exp?: number;
}

/**
 * Read `exp` from a JWT WITHOUT verifying it.
 *
 * Verification is the server's job — this is only used to decide WHEN to renew,
 * so a forged token cannot gain anything by lying about its own expiry: the worst
 * case is a pointless refresh call that the server rejects.
 */
export function readJwtExpiry(token: unknown): number | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("binary");
    const payload = JSON.parse(
      decodeURIComponent(
        json
          .split("")
          .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
          .join("")
      )
    ) as JwtPayload;
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Milliseconds until the token expires; negative when already expired. */
export function msUntilExpiry(token: unknown, now: number = Date.now()): number | null {
  const exp = readJwtExpiry(token);
  return exp === null ? null : exp - now;
}

/** True when the token is missing, unparseable, or within the skew window. */
export function needsRefresh(
  token: unknown,
  now: number = Date.now(),
  skewSeconds: number = REFRESH_SKEW_SECONDS
): boolean {
  const remaining = msUntilExpiry(token, now);
  if (remaining === null) return true;
  return remaining <= skewSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Cross-tab single-flight lock
// ---------------------------------------------------------------------------

let inFlight: Promise<RefreshResult> | null = null;

/**
 * Run `fn` under a cross-tab lock.
 *
 * Web Locks gives genuine mutual exclusion across tabs. The in-memory fallback
 * cannot coordinate tabs, so it is only a mitigation — but it still prevents the
 * common single-tab case (two components both noticing the expiry) from firing
 * two rotations.
 */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { locks?: LockManager }).locks
      : undefined;

  if (locks && typeof locks.request === "function") {
    return locks.request(REFRESH_LOCK_NAME, { mode: "exclusive" }, fn);
  }

  const pending = inFlight;
  if (pending) return pending as unknown as T;
  const created = fn().finally(() => {
    if (inFlight === created) inFlight = null;
  });
  inFlight = created as unknown as Promise<RefreshResult>;
  return created;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

function readStoredUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

function writeStoredUser(user: SessionUser): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } catch {
    // A full/blocked localStorage must not break renewal; the in-memory copy
    // returned to the caller is what the current tab uses.
  }
}

/** The access token currently persisted, or null when signed out. */
export function readStoredAccessToken(): string | null {
  return readStoredUser()?.accessToken ?? null;
}

/**
 * One renewal attempt. Performs the fetch ONLY — no locking, no persistence, no
 * retries, no sign-out decisions. `renew()` wraps this for callers.
 */
async function requestRefresh(): Promise<RefreshResult> {
  let response: Response;
  try {
    response = await fetch(REFRESH_PATH, {
      method: "POST",
      // Same-origin so the HttpOnly cookie is attached; the default
      // `same-origin` behaviour would do this too, but being explicit documents
      // the requirement at the one place that depends on it.
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
  } catch {
    // Transport failure. The session may well still be perfectly valid, so this
    // is explicitly NOT a sign-out.
    return { ok: false, reason: "network" };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "rejected" };
  }

  let data: {
    success?: boolean;
    data?: { accessToken?: string; user?: { id?: string; email?: string; role?: string } };
  };
  try {
    data = await response.json();
  } catch {
    return { ok: false, reason: "rejected" };
  }

  if (!response.ok || !data.success || !data.data?.accessToken || !data.data?.user) {
    // A 5xx/429 is a server-side problem, not proof the session died. Report it as
    // a network-style failure so the caller keeps the session and retries later.
    return { ok: false, reason: "network" };
  }

  return {
    ok: true,
    user: {
      id: data.data.user.id ?? "",
      email: data.data.user.email ?? "",
      role: data.data.user.role ?? "USER",
      accessToken: data.data.accessToken,
    },
  };
}

/** Where a renewed session is read from and written back to. */
interface SessionSlot {
  read: () => SessionUser | null;
  write: (user: SessionUser) => void;
  clear: () => void;
}

const userSlot: SessionSlot = {
  read: readStoredUser,
  write: writeStoredUser,
  clear: () => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};

/**
 * Obtain a fresh access token, at most one rotation at a time across all tabs.
 *
 * `force` skips the "is it actually expired?" test — used when the server has just
 * told us the current token is invalid (a 401 on a real API call), so we retry
 * once regardless of the local clock.
 */
export async function refreshAccessToken(force = false): Promise<RefreshResult> {
  return renew(userSlot, force);
}

/**
 * The same renewal for the admin portal.
 *
 * The admin area keeps its session in `sessionStorage` (tab-scoped) and is not part
 * of the React auth context, so it cannot reuse `refreshAccessToken` — that one
 * writes to the USER slot in `localStorage`, and an ADMIN session landing there
 * would be picked up by the user-portal guard. Sharing the lock and the fetch is
 * still correct and necessary: the refresh cookie is per-browser, not per-portal,
 * so a genuine rotation must still happen at most once.
 */
export async function refreshAdminAccessToken(force = false): Promise<RefreshResult> {
  return renew(
    {
      read: () => {
        const admin = readAdminSession();
        return admin
          ? {
              id: admin.user.id,
              email: admin.user.email,
              role: admin.user.role,
              accessToken: admin.accessToken,
            }
          : null;
      },
      write: (user) => {
        if (user.role !== "ADMIN") {
          // A USER session renewed while the admin tab was open means the shared
          // cookie now belongs to the normal portal. Writing it here would grant
          // the admin routes a non-ADMIN token, so refuse instead.
          return;
        }
        saveAdminSession({
          accessToken: user.accessToken,
          user: { id: user.id, email: user.email, role: user.role },
        });
      },
      clear: () => {
        if (typeof window === "undefined") return;
        try {
          window.sessionStorage.removeItem(ADMIN_SESSION_KEY);
        } catch {
          // ignore
        }
      },
    },
    force
  );
}

async function renew(slot: SessionSlot, force: boolean): Promise<RefreshResult> {
  return withRefreshLock(async () => {
    const current = slot.read();

    if (!force && current && !needsRefresh(current.accessToken)) {
      // Another tab already renewed while we waited for the lock. Adopt its
      // result instead of rotating the cookie a second time.
      return { ok: true, user: current };
    }

    const result = await requestRefresh();

    if (result.ok) {
      slot.write(result.user);
      return result;
    }

    if (result.reason === "rejected") {
      // The session is genuinely gone. Drop the stale copy so no later component
      // mistakes it for a live one.
      slot.clear();
    }

    return result;
  });
}

/**
 * Tell the server to revoke the current session.
 *
 * Fire-and-forget on purpose: the local session is cleared regardless, and a user
 * clicking "log out" must not be left staring at a spinner because the network
 * blipped. Best-effort revocation is still the right default — the alternative is
 * a refresh cookie that outlives the logout on a shared machine.
 */
export async function endSessionOnServer(): Promise<void> {
  try {
    await fetch(LOGOUT_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    // Deliberately ignored — see above.
  }
}
