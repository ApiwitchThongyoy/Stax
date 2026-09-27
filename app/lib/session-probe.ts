import { isSuspendedResponse } from "./session";

/**
 * Session probe (GET /api/v1/auth/session) — the ONE place that decides whether
 * a client-side auth failure is a real credential problem or a transient blip.
 *
 * There is deliberately NO inactivity/idle timer in STAX. Nothing is measured
 * from mouse/keyboard movement, page visibility, or how long a tab has been in
 * the background, and a session is never cleared because a user "did nothing".
 * A session ends only when:
 *   - the user explicitly logs out,
 *   - the server confirms the token is expired/invalid/revoked (401), or
 *   - the account is suspended (403 + ACCOUNT_SUSPENDED).
 * The access token is short-lived (15 minutes, ACCESS_TOKEN_TTL_SECONDS in
 * app/lib/refresh-session.ts) and its expiration is real server-side expiration
 * — it is never extended or faked away. A renewed session comes from the
 * HttpOnly refresh cookie via POST /api/v1/auth/refresh, orchestrated by
 * app/lib/session-refresh.ts, which is why an expired access token is a routine,
 * silent event rather than a logout. This module is the last-resort detector for
 * a session that renewal could NOT rescue.
 *
 * The bug this module fixes: a single 401 from ANY intermediary (proxy, CDN,
 * load balancer, dev overlay) used to wipe localStorage instantly, so a brief
 * outage — or a backgrounded/refreshed tab whose first probe landed after the
 * token expired — looked like an "idle logout". That is far more likely now that
 * tokens last 15 minutes. A 401 is therefore treated as a CANDIDATE and must be
 * re-confirmed before auth state is destroyed. Transient failures (offline, 5xx,
 * 408/425/429, 404 during a deploy, non-suspension 403) never clear the session.
 */

export const SESSION_STATUS_ENDPOINT = "/api/v1/auth/session";

/** Extra probes required before a 401 candidate is accepted as genuine. */
export const SESSION_UNAUTHORIZED_CONFIRM_ATTEMPTS = 2;

/** Delay between confirmation probes (ms). */
export const SESSION_CONFIRM_DELAY_MS = 400;

export type SessionProbeOutcome =
  /** Session is valid right now. */
  | "active"
  /** 403 + ACCOUNT_SUSPENDED: server-side account status, not a credential bug. */
  | "suspended"
  /** CONFIRMED 401: token expired, malformed or revoked. Only this clears auth. */
  | "unauthorized"
  /** No trustworthy statement about the credentials. Never clears auth. */
  | "transient";

/**
 * Statuses that say nothing about the caller's credentials. A 5xx from the app
 * (or a gateway) is an infrastructure failure, not an authorization decision.
 */
export function isTransientSessionStatus(status: number): boolean {
  if (status >= 500) return true; // 500/502/503/504 — server or gateway trouble
  if (status === 408 || status === 425 || status === 429) return true; // timeout / throttled
  if (status === 404) return true; // route not deployed or rewrite still rolling out
  return false;
}

/** Pure classifier: HTTP status + suspension flag -> probe outcome. */
export function classifySessionStatus(
  status: number,
  suspended: boolean
): SessionProbeOutcome {
  if (suspended) return "suspended";
  if (status >= 200 && status < 300) return "active";
  if (isTransientSessionStatus(status)) return "transient";
  if (status === 401) return "unauthorized";
  // 403 that is not ACCOUNT_SUSPENDED, 400, 402, ... : not a statement about
  // the token, so never treat it as a reason to destroy the session.
  return "transient";
}

/** True only for a confirmed auth rejection. Guards every `clearAllSessions()`. */
export function clearsSession(outcome: SessionProbeOutcome): boolean {
  return outcome === "unauthorized";
}

export interface ProbeSessionOptions {
  token: string;
  endpoint?: string;
  /** Injected in tests; defaults to the ambient fetch. */
  fetchImpl?: typeof fetch;
  confirmAttempts?: number;
  confirmDelayMs?: number;
  /** Injected in tests so confirmation does not sleep for real. */
  wait?: (ms: number) => Promise<void>;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe the session endpoint and classify the result, re-confirming a 401
 * candidate before reporting "unauthorized". Never throws: any thrown fetch
 * (offline, DNS, abort, CORS) is reported as "transient".
 */
export async function probeSession({
  token,
  endpoint = SESSION_STATUS_ENDPOINT,
  fetchImpl,
  confirmAttempts = SESSION_UNAUTHORIZED_CONFIRM_ATTEMPTS,
  confirmDelayMs = SESSION_CONFIRM_DELAY_MS,
  wait = defaultWait,
}: ProbeSessionOptions): Promise<SessionProbeOutcome> {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const attempt = async (): Promise<SessionProbeOutcome> => {
    try {
      const res = await doFetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const suspended = await isSuspendedResponse(res);
      return classifySessionStatus(res.status, suspended);
    } catch {
      return "transient";
    }
  };

  let outcome = await attempt();
  if (outcome !== "unauthorized") return outcome;

  for (let i = 0; i < confirmAttempts; i++) {
    if (confirmDelayMs > 0) await wait(confirmDelayMs);
    outcome = await attempt();
    // A success or a transient failure during confirmation means the single
    // earlier 401 was not a real credential rejection: keep the session.
    if (outcome !== "unauthorized") return outcome;
  }

  return "unauthorized";
}
