import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Loader2, AlertCircle, CheckCheck } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  useSuspendedAccount,
  flagSuspendedFromResponse,
} from "../../lib/suspended-account";

interface NotificationItem {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: string;
  isRead: boolean;
  createdAt: string;
}

const STORAGE_KEY = "stax_auth_user";

function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { accessToken?: string };
    return typeof parsed.accessToken === "string" ? parsed.accessToken : null;
  } catch {
    return null;
  }
}

export default function NotificationBell() {
  const { user } = useAuth();
  const { suspended, markSuspended } = useSuspendedAccount();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [metaUnread, setMetaUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notificationEnabled, setNotificationEnabled] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (suspended) return;
    const token = user?.accessToken || getAccessToken();
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [notifRes, settingsRes] = await Promise.all([
        fetch("/api/v1/notifications", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch("/api/v1/settings", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (
        (await flagSuspendedFromResponse(notifRes, markSuspended)) ||
        (await flagSuspendedFromResponse(settingsRes, markSuspended))
      ) {
        setLoading(false);
        return;
      }
      const notifData = await notifRes.json().catch(() => null);
      const settingsData = await settingsRes.json().catch(() => null);
      if (notifData?.success) {
        setNotifications((notifData.data as NotificationItem[]) ?? []);
        setMetaUnread(notifData.meta?.unreadCount ?? 0);
      }
      if (settingsData?.success && settingsData.data) {
        setNotificationEnabled(
          settingsData.data.notificationEnabled ?? true
        );
      }
    } catch {
      setError("ไม่สามารถโหลดการแจ้งเตือนได้");
    } finally {
      setLoading(false);
    }
  }, [user?.accessToken, suspended, markSuspended]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const unreadCount = metaUnread;

  const markRead = async (id: string) => {
    if (suspended) return;
    const token = user?.accessToken || getAccessToken();
    if (!token) return;
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
    );
    setMetaUnread((prev) => Math.max(0, prev - 1));
    try {
      const res = await fetch(`/api/v1/notifications/${id}/read`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      });
      await flagSuspendedFromResponse(res, markSuspended);
    } catch {
      load();
    }
  };

  const markAllRead = async () => {
    if (suspended) return;
    const token = user?.accessToken || getAccessToken();
    if (!token) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setMetaUnread(0);
    try {
      const res = await fetch("/api/v1/notifications", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      });
      await flagSuspendedFromResponse(res, markSuspended);
    } catch {
      load();
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((prev) => !prev);
          if (!open) load();
        }}
        className="relative w-9 h-9 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-50 transition"
        aria-label="การแจ้งเตือน"
      >
        <Bell className="w-4 h-4" />
        {notificationEnabled && unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-80 max-h-[28rem] flex flex-col bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-800">การแจ้งเตือน</p>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-blue-800 font-medium hover:underline"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                อ่านทั้งหมด
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="py-10 flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-blue-900" />
              </div>
            ) : error && notifications.length === 0 ? (
              <div className="py-10 flex flex-col items-center justify-center text-center px-6">
                <AlertCircle className="w-5 h-5 text-red-500 mb-2" />
                <p className="text-xs text-gray-500">{error}</p>
              </div>
            ) : notifications.length === 0 ? (
              <div className="py-10 flex flex-col items-center justify-center text-center px-6">
                <Bell className="w-5 h-5 text-gray-300 mb-2" />
                <p className="text-sm text-gray-500">ยังไม่มีการแจ้งเตือน</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {notifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => !n.isRead && markRead(n.id)}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-50/60 transition ${
                      !n.isRead ? "bg-blue-50/40" : ""
                    }`}
                  >
                    <p className="text-sm font-medium text-gray-800">
                      {n.title}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                      {n.message}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
