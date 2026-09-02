import { useEffect, useRef } from "react";
import { isSuspendedResponse } from "./session";

export const ADMIN_USERS_POLL_INTERVAL_MS = 5_000;

export interface AdminUsersApiRow {
  id: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt?: string | null;
  lastSeenAt?: string | null;
  createdAt?: string | null;
  documentCount?: number;
}

interface UseAdminUsersPollingOptions {
  /** True only while an authenticated ADMIN session is active AND the admin
   *  dashboard is mounted. When false the poll never runs. */
  enabled: boolean;
  /** ADMIN JWT used to authorize the request. */
  accessToken: string | null;
  /** Called with fresh user rows on every successful poll. */
  onUsers: (rows: AdminUsersApiRow[]) => void;
  /** Called once when the poll detects the session is suspended (403 +
   *  ACCOUNT_SUSPENDED) so the caller can clear the admin session/redirect. */
  onSuspended: () => void;
  intervalMs?: number;
}

/**
 * Lightweight periodic refresh of the admin user list (used to keep presence
 * ONLINE/OFFLINE current without a manual page refresh).
 *
 * - Re-fetches /api/v1/admin/users every 5s.
 * - Uses a chained setTimeout, not setInterval, so requests never overlap and
 *   no duplicate polling loops can accumulate.
 * - Stops as soon as `enabled` becomes false (logout / unmount / navigation)
 *   or the component unmounts.
 * - On 403 + ACCOUNT_SUSPENDED it calls onSuspended() once and stops polling
 *   (the admin session is no longer valid).
 * - Silently tolerates transient network errors and simply reschedules.
 */
export function useAdminUsersPolling({
  enabled,
  accessToken,
  onUsers,
  onSuspended,
  intervalMs = ADMIN_USERS_POLL_INTERVAL_MS,
}: UseAdminUsersPollingOptions) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;
  const onUsersRef = useRef(onUsers);
  onUsersRef.current = onUsers;
  const onSuspendedRef = useRef(onSuspended);
  onSuspendedRef.current = onSuspended;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };

    const poll = async () => {
      const activeToken = tokenRef.current;
      if (!alive || !enabledRef.current || !activeToken) return;
      try {
        const res = await fetch("/api/v1/admin/users", {
          headers: { Authorization: `Bearer ${activeToken}` },
        });
        if (!alive) return;
        if (await isSuspendedResponse(res)) {
          onSuspendedRef.current();
          return;
        }
        if (!res.ok) {
          schedule();
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          data?: AdminUsersApiRow[];
        } | null;
        if (!alive) return;
        if (data?.data) {
          onUsersRef.current(data.data);
        }
        schedule();
      } catch {
        schedule();
      }
    };

    const schedule = () => {
      if (!alive) return;
      timer = setTimeout(poll, intervalMs);
    };

    if (enabled && accessToken) {
      schedule();
    }

    return stop;
  }, [enabled, accessToken, intervalMs]);
}
