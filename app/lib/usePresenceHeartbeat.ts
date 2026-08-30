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
 * - Stops immediately when `enabled` becomes false (logout / navigation away
 *   from a protected route) or on unmount.
 * - Never fires without a valid accessToken.
 * - Failures are logged (not awaited) and the loop simply reschedules.
 */
export function usePresenceHeartbeat({
  enabled,
  accessToken,
  intervalMs = PRESENCE_HEARTBEAT_INTERVAL_MS,
}: UsePresenceHeartbeatOptions) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;

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
      try {
        await fetch("/api/v1/auth/heartbeat", {
          method: "POST",
          headers: { Authorization: `Bearer ${activeToken}` },
        });
      } catch (error) {
        console.error("Presence heartbeat failed", error);
      } finally {
        if (alive) {
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
