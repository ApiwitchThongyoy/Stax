import { useEffect, useRef } from "react";
import { probeSession } from "./session-probe";
import { refreshAccessToken } from "./session-refresh";

export const ACCOUNT_STATUS_POLL_INTERVAL_MS = 5000;

interface UseAccountStatusPollingOptions {
  enabled: boolean;
  accessToken: string | null;
  onSuspended: () => void;
  onActive: () => void;
  /** Called once when the server CONFIRMS 401 (expired/invalid JWT). */
  onUnauthorized?: () => void;
  intervalMs?: number;
}

/**
 * Lightweight periodic check of the current account's DB-backed status while an
 * authenticated user dashboard is open. Fetches /api/v1/auth/session on a fixed
 * interval.
 *
 * - On a CONFIRMED 401 (expired/invalid JWT) it stops polling immediately and
 *   calls onUnauthorized so the client can clear the session. A lone 401 is only
 *   a candidate: `probeSession` re-confirms it, so a single transient 401 from a
 *   proxy/gateway can no longer wipe the session. Network errors and 5xx
 *   responses are transient and NEVER clear auth state.
 * - On 403 + ACCOUNT_SUSPENDED it calls onSuspended() the FIRST time the status
 *   flips to suspended, then keeps polling so a later reactivation can be
 *   detected (the minimal check needed while the suspended overlay is active).
 * - When the status returns to ACTIVE after having been suspended, it calls
 *   onActive() (which shows the welcome/reactivated dialog) and stops polling.
 * - Polling also stops on unmount or when `enabled` becomes false.
 *
 * There is NO inactivity/idle timeout here and none anywhere else in the app:
 * idling, switching tabs or minimizing the browser never signs a user out.
 * (setTimeout chains are also throttled by the browser in background tabs, so a
 * backgrounded tab simply polls less often — it is never treated as "idle".)
 *
 * Uses a chained setTimeout rather than setInterval so requests never overlap
 * and no duplicate polling loops can accumulate.
 */
export function useAccountStatusPolling({
  enabled,
  accessToken,
  onSuspended,
  onActive,
  onUnauthorized,
  intervalMs = ACCOUNT_STATUS_POLL_INTERVAL_MS,
}: UseAccountStatusPollingOptions) {
  const onSuspendedRef = useRef(onSuspended);
  onSuspendedRef.current = onSuspended;
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastWasSuspended = false;

    const stop = () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };

    const loop = async () => {
      if (!alive || !enabledRef.current) return;
      if (!accessToken) return;
      // probeSession never throws and never reports a transient failure as an
      // auth rejection, so the session survives offline/5xx hiccups and a
      // backgrounded tab that only polls again minutes later.
      const outcome = await probeSession({ token: accessToken });
      if (!alive) return;
      if (outcome === "suspended") {
        if (!lastWasSuspended) {
          lastWasSuspended = true;
          onSuspendedRef.current();
        }
        schedule();
      } else if (outcome === "active") {
        if (lastWasSuspended) {
          lastWasSuspended = false;
          onActiveRef.current();
          return;
        }
        schedule();
      } else if (outcome === "unauthorized") {
        // CONFIRMED 401 — but a confirmed 401 does NOT yet prove the SESSION is
        // dead. The token in this closure can simply be the one that was in
        // flight when a renewal rotated it (or one a backgrounded tab slept
        // through). Clearing auth state on that basis would sign out a perfectly
        // valid session, so a stale token is treated as a reason to renew first:
        //   * renewed  -> keep polling with the new token (the auth context
        //     re-renders, which restarts this effect with the fresh token)
        //   * rejected -> the server genuinely refuses the session: stop and let
        //     the client clear it
        //   * network  -> transient, same as any other offline blip: retry
        const renewed = await refreshAccessToken(true);
        if (!alive) return;
        if (renewed.ok) {
          schedule();
        } else if (renewed.reason === "rejected") {
          stop();
          onUnauthorizedRef.current?.();
        } else {
          schedule();
        }
      } else {
        // transient (offline / 5xx / throttled) — keep the session and retry.
        schedule();
      }
    };

    const schedule = () => {
      if (!alive) return;
      timer = setTimeout(loop, intervalMs);
    };

    if (enabled && accessToken) {
      // Check immediately on mount so an already-suspended account is blocked
      // right away (no wait for the first full interval), then every 5s.
      void loop();
    }

    return stop;
  }, [enabled, accessToken, intervalMs]);
}
