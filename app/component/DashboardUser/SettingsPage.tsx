import { useCallback, useEffect, useState } from "react";
import { Bell, Mail, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  useSuspendedAccount,
  flagSuspendedFromResponse,
} from "../../lib/suspended-account";

interface UserSettings {
  id: string;
  userId: string;
  notificationEnabled: boolean;
  emailNotificationEnabled: boolean;
  createdAt: string;
  updatedAt: string;
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

export default function SettingsPage() {
  const { user } = useAuth();
  const { suspended, markSuspended } = useSuspendedAccount();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (suspended) return;
    const token = user?.accessToken || getAccessToken();
    if (!token) {
      setError("ไม่พบข้อมูลการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/v1/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (await flagSuspendedFromResponse(res, markSuspended)) {
        setLoading(false);
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError("ไม่สามารถโหลดการตั้งค่าได้");
        return;
      }
      setSettings(data.data as UserSettings);
    } catch {
      setError("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้");
    } finally {
      setLoading(false);
    }
  }, [user?.accessToken, suspended, markSuspended]);

  useEffect(() => {
    load();
  }, [load]);

  const updateField = async (key: "notificationEnabled" | "emailNotificationEnabled", value: boolean) => {
    if (!settings) return;
    const token = user?.accessToken || getAccessToken();
    if (!token) return;
    if (suspended) return;

    const optimistic: UserSettings = { ...settings, [key]: value };
    setSettings(optimistic);
    setSavingKey(key);
    setSaved(false);
    setError("");
    try {
      const res = await fetch("/api/v1/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ [key]: value }),
      });
      if (await flagSuspendedFromResponse(res, markSuspended)) {
        setLoading(false);
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError("ไม่สามารถบันทึกการตั้งค่าได้");
        return;
      }
      setSettings(data.data as UserSettings);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch {
      setError("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้");
      setSettings(settings);
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-10 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-blue-900" />
        <span className="ml-2 text-sm text-gray-500">กำลังโหลดการตั้งค่า...</span>
      </div>
    );
  }

  if (error && !settings) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-6 text-center">
        <AlertCircle className="w-6 h-6 text-red-500 mx-auto mb-2" />
        <p className="text-sm font-medium text-red-600">{error}</p>
        <button
          type="button"
          onClick={load}
          className="mt-3 text-xs text-blue-900 font-medium underline"
        >
          ลองอีกครั้ง
        </button>
      </div>
    );
  }

  const toggles: {
    key: "notificationEnabled" | "emailNotificationEnabled";
    title: string;
    description: string;
    Icon: typeof Bell;
  }[] = [
    {
      key: "notificationEnabled",
      title: "การแจ้งเตือนในระบบ",
      description: "เปิด/ปิดการแสดงการแจ้งเตือนในระบบ",
      Icon: Bell,
    },
    {
      key: "emailNotificationEnabled",
      title: "การแจ้งเตือนทางอีเมล",
      description: "เปิด/ปิดการส่งการแจ้งเตือนทางอีเมล",
      Icon: Mail,
    },
  ];

  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-800">
          การตั้งค่าการแจ้งเตือน
        </h2>
        <p className="text-xs text-gray-400 mt-0.5">
          จัดการความต้องการรับการแจ้งเตือนของคุณ
        </p>
      </div>

      {saved && (
        <div className="mx-5 mt-4 flex items-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-50 text-emerald-600 text-sm">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>บันทึกการตั้งค่าเรียบร้อยแล้ว</span>
        </div>
      )}

      {error && (
        <div className="mx-5 mt-4 flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-50 text-red-600 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="divide-y divide-gray-50">
        {toggles.map(({ key, title, description, Icon }) => (
          <div
            key={key}
            className="flex items-center justify-between gap-4 px-5 py-4"
          >
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-blue-800" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800">{title}</p>
                <p className="text-xs text-gray-400 mt-0.5">{description}</p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings?.[key] ?? false}
              disabled={savingKey === key}
              onClick={() =>
                updateField(key, !(settings?.[key] ?? false))
              }
              className={`shrink-0 relative w-11 h-6 rounded-full transition disabled:opacity-60 ${
                settings?.[key] ? "bg-blue-900" : "bg-gray-200"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  settings?.[key] ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
