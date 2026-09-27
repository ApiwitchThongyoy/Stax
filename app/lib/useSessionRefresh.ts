import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "./auth";
import {
  needsRefresh,
  readJwtExpiry,
  readStoredAccessToken,
  refreshAccessToken,
  type RefreshResult,
} from "./session-refresh";

/**
 * Keeps the 15-minute access token alive for as long as the user is working.
 *
 * The token is renewed by calling POST /api/v1/auth/refresh, which the browser
 * authenticates with the HttpOnly refresh cookie. This hook owns exactly three
 * concerns and nothing else:
 *
 *   1. A TIMER, so a token is renewed shortly before it expires while the tab is
 *      open and the user is idle-reading a report. Renewal is a background
 *      concern — the user must never be asked to log in again because they
 *      stopped clicking for fifteen minutes.
 *   2. FOCUS / VISIBILITY, which is what actually matters in practice. A laptop
 *      that slept, a phone that was locked, or a tab left in the background for
 *      an hour all come back with an already-expired token, and the first API
 *      call after that would be a 401. Re-checking on return turns a guaranteed
 *      logout into a silent renewal.
 *   3. A FAILURE POLICY: only a server-confirmed rejection signs the user out.
 *      A network error leaves the session alone and the timer is retried, because
 *      being offline is not the same as being logged out.
 *
 * It deliberately does NOT react to mouse movement, key presses, or any other
 * activity signal. STAX has no idle timeout by design, and adding one here would
 * reintroduce the behaviour this app was built to avoid.
 */

/** How long to wait before retrying after a failed (non-sign-out) attempt. */
const RETRY_DELAY_MS = 30_000;

/** Never schedule closer than this, so a fast expiry cannot spin the timer. */
const MIN_SCHEDULE_MS = 5_000;

/**
 * When to wake up for a token that expires at `expiresAt`.
 *
 * Pure and exported for tests. Clamped to a floor so a token that is somehow
 * already inside the skew window cannot produce a zero-delay loop, and capped at
 * a ceiling so a token with a bogus far-future `exp` still gets re-checked
 * periodically instead of trusting it indefinitely.
 */
export function nextRefreshDelayMs(
  expiresAt: number,
  now: number = Date.now(),
  skewMs: number = 60_000
): number {
  const untilExpiry = expiresAt - now - skewMs;
  return Math.min(Math.max(untilExpiry, MIN_SCHEDULE_MS), 15 * 60_000);
}

export interface UseSessionRefreshOptions {
  /** Injected in tests; defaults to the ambient fetch path. */
  refresh?: (force?: boolean) => Promise<RefreshResult>;
  enabled?: boolean;
}

export function useSessionRefresh({
  refresh = refreshAccessToken,
  enabled = true,
}: UseSessionRefreshOptions = {}) {
  const { user, applyRefreshedSession, clearSession } = useAuth();

  // Everything the timer and the event listeners need, held in refs so re-renders
  // never tear down and re-create an in-flight renewal.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  // Guards against a state update after unmount. Without this, a renewal that
  // resolves during navigation logs a React warning.
  const aliveRef = useRef(true);
  const refreshRef = useRef(refresh);
  const applyRef = useRef(applyRefreshedSession);
  const clearRef = useRef(clearSession);

  refreshRef.current = refresh;
  applyRef.current = applyRefreshedSession;
  clearRef.current = clearSession;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * Run one renewal and schedule the next one.
   *
   * `runningRef` is the important part: a timer firing while a focus event fires
   * while a visibilitychange fires would otherwise send three concurrent
   * requests. The server would answer the extra two with "reuse detected" and
   * revoke the family, logging the user out of every tab. Renewal must be
   * idempotent per tab, and the cross-tab lock in session-refresh.ts covers the
   * remaining (multi-tab) case.
   */
  const runRefresh = useCallback(
    async (force: boolean) => {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        const result = await refreshRef.current(force);
        if (!aliveRef.current) return;

        if (result.ok) {
          applyRef.current(result.user);
          scheduleRef.current?.();
          return;
        }

        if (result.reason === "rejected") {
          // The server owns this decision: the refresh session is gone (expired,
          // revoked, or the account is no longer ACTIVE). Sign out for real.
          clearRef.current();
          return;
        }

        // network / noSession — not proof of anything. Keep the session and try
        // again shortly; the user is probably just offline or behind a flaky
        // proxy.
        clearTimer();
        timerRef.current = setTimeout(() => {
          void runRefreshRef.current?.(false);
        }, RETRY_DELAY_MS);
      } catch {
        // The helper is written not to throw, but a defensive catch here means a
        // surprise cannot take down the page or silently stop all future renewal.
        clearTimer();
        timerRef.current = setTimeout(() => {
          void runRefreshRef.current?.(false);
        }, RETRY_DELAY_MS);
      } finally {
        runningRef.current = false;
      }
    },
    [clearTimer]
  );

  // Indirection so the recursive retry above does not need `runRefresh` in its
  // own dependency list.
  const runRefreshRef = useRef<((force: boolean) => Promise<void>) | null>(null);
  runRefreshRef.current = runRefresh;

  const schedule = useCallback(
    (token?: string) => {
      clearTimer();
      const activeToken = token ?? user?.accessToken;
      if (!enabled || !activeToken) return;

      const expiresAt = needsRefresh(activeToken)
        ? Date.now() // already stale — renew now, the timer is a safety net
        : Date.now() + Math.max(0, expiryRemaining(activeToken));

      timerRef.current = setTimeout(
        () => void runRefreshRef.current?.(false),
        nextRefreshDelayMs(expiresAt)
      );
    },
    [clearTimer, enabled, user?.accessToken]
  );
  const scheduleRef = useRef<((token?: string) => void) | null>(null);
  scheduleRef.current = schedule;

  // --- mount / session change: restore + schedule ---------------------------
  useEffect(() => {
    aliveRef.current = true;
    if (!enabled) return;
    if (!user) {
      clearTimer();
      return;
    }

    // On a fresh page load the token in localStorage may be anywhere from
    // brand-new to long expired. Renew immediately when it is close to expiry so
    // the first real API call of the session does not race a 401.
    if (needsRefresh(user.accessToken)) {
      void runRefresh(true);
    } else {
      schedule(user.accessToken);
    }

    return () => {
      aliveRef.current = false;
      clearTimer();
    };
  }, [clearTimer, enabled, runRefresh, schedule, user]);

  // --- return to the tab: renew if the token died while we were away --------
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const onWake = () => {
      if (document.visibilityState === "hidden") return;
      if (document.hidden) return;
      const current = readStoredAccessToken();
      // Only act when there is actually something to fix, so ordinary tab
      // switching does not generate background traffic.
      if (current && needsRefresh(current)) void runRefreshRef.current?.(true);
    };

    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [enabled]);

  return { refreshNow: () => runRefresh(true) };
}

function expiryRemaining(token: string): number {
  const exp = readJwtExpiry(token);
  return exp === null ? 0 : Math.max(0, exp - Date.now());
}
