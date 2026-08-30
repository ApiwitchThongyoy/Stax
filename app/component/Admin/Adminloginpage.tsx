import { useEffect, useState } from "react";
import { Mail, Lock, Eye, EyeOff, ShieldCheck, Users, AlertCircle } from "lucide-react";
import { Link } from "react-router";
import { useNavigate, useLocation } from "react-router";
import StaxLogo from "../Login/StaxLogo";
import { saveAdminSession } from "../../lib/admin-auth";

interface LoginApiResponse {
  success?: boolean;
  data?: {
    accessToken?: string;
    user?: { id?: string; email?: string; role?: string };
  };
}

export default function StaxAdminLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const suspended = (location.state as { suspended?: boolean } | null)
      ?.suspended;
    if (suspended) {
      setErrorMessage(
        "บัญชีนี้ถูกระงับ โปรดติดต่อผู้ดูแลระบบที่ [email]"
      );
    }
  }, [location.state]);

  const handleLogin = async () => {
    const trimmedEmail = email.trim();

    if (!trimmedEmail || !password) {
      setErrorMessage("กรุณากรอกอีเมลและรหัสผ่านให้ครบถ้วน");
      return;
    }

    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });

      const data = (await response.json().catch(() => null)) as LoginApiResponse | null;

      if (response.status === 403) {
        const msg =
          (data as { message?: string } | null)?.message ||
          "บัญชีนี้ถูกระงับ โปรดติดต่อผู้ดูแลระบบที่ [email]";
        setErrorMessage(msg);
        return;
      }

      if (!response.ok || !data?.success || !data.data?.accessToken || !data.data.user) {
        setErrorMessage("อีเมลหรือรหัสผ่านผู้ดูแลระบบไม่ถูกต้อง");
        return;
      }

      const { accessToken, user } = data.data;
      const adminUser = {
        id: user.id ?? "",
        email: user.email ?? trimmedEmail,
        role: user.role ?? "",
      };

      // อนุญาตเฉพาะบัญชี role ADMIN — บัญชี USER ปฏิเสธการเข้าและแจ้งว่าไม่มีสิทธิ์
      if (adminUser.role !== "ADMIN") {
        setErrorMessage("บัญชีนี้ไม่ใช่ผู้ดูแลระบบ จึงไม่มีสิทธิ์เข้าใช้งานส่วนนี้");
        return;
      }

      setErrorMessage("");

      // เก็บ JWT/accessToken + user ที่ backend คืนมาไว้ใน session (หายเมื่อปิดแท็บ)
      // ใช้ให้ AdminProtectedRoute ตรวจสิทธิ์ก่อนปล่อยเข้า /admin/dashboard
      saveAdminSession({ accessToken, user: adminUser });

      // เด้งกลับไป path ที่ตั้งใจจะเข้าตั้งแต่แรก (ถ้ามี) ไม่งั้นไป admin dashboard
      const from = (location.state as { from?: string } | null)?.from || "/admin/dashboard";
      navigate(from, { replace: true, state: { email: adminUser.email } });
    } catch {
      setErrorMessage("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleLogin();
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 relative overflow-hidden p-4">
      {/* Background decorative dots */}
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(circle, #d1d5db 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      />

      {/* Soft gradient blobs */}
      <div className="absolute -left-24 top-1/3 w-72 h-72 bg-blue-100 rounded-full blur-3xl opacity-60" />
      <div className="absolute -right-24 bottom-1/4 w-72 h-72 bg-indigo-100 rounded-full blur-3xl opacity-60" />

      {/* Decorative floating cards */}
      <div className="hidden md:flex absolute left-[12%] top-[38%] items-center gap-3 bg-white rounded-xl shadow-md px-4 py-3 w-48">
        <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
          <ShieldCheck className="w-4 h-4 text-blue-700" />
        </div>
        <div className="h-2 bg-gray-200 rounded w-full" />
      </div>
      <div className="hidden md:flex absolute left-[10%] top-[46%] items-center gap-3 bg-white rounded-xl shadow-md px-4 py-3 w-48">
        <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
          <Users className="w-4 h-4 text-indigo-600" />
        </div>
        <div className="h-2 bg-gray-200 rounded w-full" />
      </div>

      {/* Main card */}
      <div className="relative z-10 w-full max-w-3xl bg-white rounded-2xl shadow-xl overflow-hidden grid md:grid-cols-2">
        {/* Left panel */}
        <div className="bg-linear-to-br from-blue-900 to-blue-950 flex flex-col items-center justify-center text-center px-8 py-12">
          <StaxLogo
            width="220px"
            transparent
            textColor="#ffffff"
            subTextColor="#bfdbfe"
            dividerColor="rgba(255,255,255,0.25)"
          />
          <span className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase text-blue-200 bg-white/10 px-3 py-1 rounded-full">
            <ShieldCheck className="w-3.5 h-3.5" />
            สำหรับผู้ดูแลระบบเท่านั้น
          </span>
        </div>

        {/* Right panel - form */}
        <div className="flex flex-col justify-center px-8 py-10 sm:px-10">
          <div>
            <p className="text-xs text-gray-400 mb-1">เข้าสู่ระบบ</p>
            <h1 className="text-lg font-semibold text-gray-800 mb-6">
              STAX ADMIN
            </h1>

            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              อีเมล
            </label>
            <div className="relative mb-5">
              <Mail className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errorMessage) setErrorMessage("");
                }}
                onKeyDown={handleKeyDown}
                placeholder="admin@company.com"
                className="w-full pl-9 pr-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
              />
            </div>

            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              รหัสผ่าน
            </label>
            <div className="relative mb-4">
              <Lock className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errorMessage) setErrorMessage("");
                }}
                onKeyDown={handleKeyDown}
                placeholder="••••••••"
                className="w-full pl-9 pr-9 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                aria-label={showPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4 cursor-pointer" />
                ) : (
                  <Eye className="w-4 h-4 cursor-pointer" />
                )}
              </button>
            </div>

            {errorMessage && (
              <div className="flex items-center gap-2 mb-4 px-3 py-2.5 rounded-lg bg-red-50 text-red-600 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            <label className="flex items-center gap-2 mb-6 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-blue-900 focus:ring-blue-900/30"
              />
              <span className="text-sm text-gray-600">จดจำฉันในระบบ</span>
            </label>

            <button
              type="button"
              onClick={handleLogin}
              className="w-full bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg flex items-center justify-center gap-2 transition cursor-pointer"
            >
              เข้าสู่ระบบADMIN
              <span aria-hidden="true">›</span>
            </button>

            <p className="text-center text-sm text-gray-500 mt-6">
              ไม่ใช่ผู้ดูแลระบบ?{" "}
              <Link
                to="/login"
                className="text-blue-800 font-medium hover:underline"
              >
                เข้าสู่ระบบผู้ใช้ทั่วไป
              </Link>
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="absolute bottom-4 left-0 right-0 text-center text-xs text-gray-400 space-y-1">
        <p>© 2026 STAX Financial Management. All Rights Reserved.</p>
        <p>
          <button className="hover:underline">Privacy Policy</button>
          {"  ·  "}
          <button className="hover:underline">Terms of Service</button>
        </p>
      </div>
    </div>
  );
}