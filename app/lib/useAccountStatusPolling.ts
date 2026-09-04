import { useEffect, useRef } from "react";
import { isSuspendedResponse } from "./session";

export const ACCOUNT_STATUS_POLL_INTERVAL_MS = 5000;

interface UseAccountStatusPollingOptions {
  enabled: boolean;
  accessToken: string | null;
  onSuspended: () => void;
  onActive: () => void;
  /** Called once when the server returns 401 (expired/invalid JWT). */
  onUnauthorized?: () => void;
  intervalMs?: number;
}

/**
 * Lightweight periodic check of the current account's DB-backed status while an
 * authenticated user dashboard is open. Fetches /api/v1/auth/session on a fixed
 * interval.
 *
 * - On 401 (expired/invalid JWT) it stops polling immediately and calls
 *   onUnauthorized so the client can clear the session.
 * - On 403 + ACCOUNT_SUSPENDED it calls onSuspended() the FIRST time the status
 *   flips to suspended, then keeps polling so a later reactivation can be
 *   detected (the minimal check needed while the suspended overlay is active).
 * - When the status returns to ACTIVE after having been suspended, it calls
 *   onActive() (which shows the welcome/reactivated dialog) and stops polling.
 * - Polling also stops on unmount or when `enabled` becomes false.
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
      try {
        const res = await fetch("/api/v1/auth/session", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!alive) return;
        if (await isSuspendedResponse(res)) {
          if (!lastWasSuspended) {
            lastWasSuspended = true;
            onSuspendedRef.current();
          }
          schedule();
        } else if (res.ok) {
          if (lastWasSuspended) {
            lastWasSuspended = false;
            onActiveRef.current();
            return;
          }
          schedule();
        } else if (res.status === 401) {
          // JWT expired or invalid — stop polling and notify so the client can
          // clear the session.  Do NOT schedule another poll.
          stop();
          onUnauthorizedRef.current?.();
        } else {
          schedule();
        }
      } catch {
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
