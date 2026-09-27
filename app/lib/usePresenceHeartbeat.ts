import { useEffect, useRef } from "react";
import { probeSession } from "./session-probe";
import { refreshAccessToken } from "./session-refresh";

export const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;

interface UsePresenceHeartbeatOptions {
  /**
   * True only while an authenticated session exists AND the current page is a
   * protected (non-public) route. When false the heartbeat never runs.
   */
  enabled: boolean;
  /** The authenticated user's JWT used to prove identity to the server. */
  accessToken: string | null;
  /** Called once when the server CONFIRMS 401 (expired/invalid JWT). */
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
 * - Stops and calls onUnauthorized only after a 401 is CONFIRMED against
 *   /api/v1/auth/session. A single 401 (proxy/CDN hiccup) or any transient
 *   failure (offline, 5xx, throttling) leaves the session intact and the loop
 *   keeps beating.
 * - Stops immediately when `enabled` becomes false (logout / navigation away
 *   from a protected route) or on unmount.
 * - Never fires without a valid accessToken.
 * - Failures are logged (not awaited) and the loop simply reschedules.
 * - There is NO inactivity/idle cutoff: a backgrounded or minimized tab is
 *   merely throttled by the browser, it is never signed out for being idle.
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
          // A lone 401 is only a CANDIDATE: it can come from a proxy/CDN rather
          // than from the credential. Re-confirm it against the authoritative
          // session endpoint before destroying the session, so a short outage
          // (or a backgrounded tab whose first beat lands after the token
          // expired) never looks like an idle logout. A confirmed 401 — expired
          // or revoked token — still stops the loop and clears auth.
          const outcome = await probeSession({ token: activeToken });
          if (outcome === "unauthorized") {
            // A confirmed 401 can still mean a STALE token rather than a dead
            // session: the beat may have gone out with the token that renewal
            // rotated a moment earlier, or a backgrounded tab may wake up long
            // after expiry. Renew once before giving up, or every backgrounded
            // tab would sign the user out instead of catching up.
            const renewed = await refreshAccessToken(true);
            if (renewed.ok) {
              // Session is alive; the next beat uses the rotated token.
              return;
            }
            if (renewed.reason === "rejected") {
              reschedule = false;
              stop();
              onUnauthorizedRef.current?.();
              return;
            }
            // Transient network failure while renewing: keep beating and let the
            // retry decide. Never destroy the session on an offline blip.
          }
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
