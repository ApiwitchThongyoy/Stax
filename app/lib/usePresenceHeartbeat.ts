import { useEffect, useRef } from "react";

export const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;

interface UsePresenceHeartbeatOptions {
  /**
   * True only while an authenticated session exists AND the current page is a
   * protected (non-public) route. When false the heartbeat never runs.
   */
  enabled: boolean;
  /** The authenticated user's JWT used to prove identity to the server. */
  accessToken: string | null;
  /** Called once when the server returns 401 (expired/invalid JWT). */
  onUnauthorized?: () => void;
  intervalMs?: number;
}

/**
 * Tracks real online presence: every 30s it POSTs to /api/v1/auth/heartbeat
 * which bumps `last_seen_at` for the authenticated user (the backend derives
 * the userId ONLY from the JWT — never from the client body).
 *
 * Guardrails:
 * - Uses a chained setTimeout, not setInterval, so requests never overlap and
 *   no duplicate heartbeat loops can accumulate.
 * - Stops immediately when the server returns 401 (expired/invalid JWT) and
 *   calls onUnauthorized so the client can clear the session.
 * - Stops immediately when `enabled` becomes false (logout / navigation away
 *   from a protected route) or on unmount.
 * - Never fires without a valid accessToken.
 * - Failures are logged (not awaited) and the loop simply reschedules.
 */
export function usePresenceHeartbeat({
  enabled,
  accessToken,
  onUnauthorized,
  intervalMs = PRESENCE_HEARTBEAT_INTERVAL_MS,
}: UsePresenceHeartbeatOptions) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };

    const beat = async () => {
      const activeToken = tokenRef.current;
      if (!alive || !enabledRef.current || !activeToken) return;
      let reschedule = true;
      try {
        const res = await fetch("/api/v1/auth/heartbeat", {
          method: "POST",
          headers: { Authorization: `Bearer ${activeToken}` },
        });
        if (res.status === 401) {
          // JWT expired or invalid — stop immediately, do NOT reschedule.
          reschedule = false;
          stop();
          onUnauthorizedRef.current?.();
          return;
        }
      } catch (error) {
        console.error("Presence heartbeat failed", error);
      } finally {
        if (alive && reschedule) {
          timer = setTimeout(beat, intervalMs);
        }
      }
    };

    if (enabled && accessToken) {
      // Fire once immediately so presence is reflected right away (e.g. right
      // after login / page reload), then keep beating every `intervalMs`.
      void beat();
    }

    return stop;
  }, [enabled, accessToken, intervalMs]);
}
