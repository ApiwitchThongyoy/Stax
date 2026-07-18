import { useState } from "react";
import { Mail, Lock,Eye, EyeOff, LayoutDashboard, FileBarChart } from "lucide-react";
import { Link } from "react-router";
import StaxLogo from "./StaxLogo"

export default function StaxLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
      <div className="absolute -left-24 top-1/3 w-72 h-72 bg-emerald-100 rounded-full blur-3xl opacity-60" />
      <div className="absolute -right-24 bottom-1/4 w-72 h-72 bg-blue-100 rounded-full blur-3xl opacity-60" />

      {/* Decorative floating cards */}
      <div className="hidden md:flex absolute left-[12%] top-[38%] items-center gap-3 bg-white rounded-xl shadow-md px-4 py-3 w-48">
        <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
          <FileBarChart className="w-4 h-4 text-emerald-500" />
        </div>
        <div className="h-2 bg-gray-200 rounded w-full" />
      </div>
      <div className="hidden md:flex absolute left-[10%] top-[46%] items-center gap-3 bg-white rounded-xl shadow-md px-4 py-3 w-48">
        <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
          <LayoutDashboard className="w-4 h-4 text-blue-500" />
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
        </div>

        {/* Right panel - form */}
        <div className="flex flex-col justify-center px-8 py-10 sm:px-10">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              อีเมลผู้ใช้งาน
            </label>
            <div className="relative mb-5">
              <Mail className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
              />
            </div>

            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-gray-700">
                รหัสผ่าน
              </label>
              <button
                type="button"
                className="text-sm text-blue-800 hover:underline cursor-pointer"
              >
                ลืมรหัสผ่าน?
              </button>
            </div>
            <div className="relative mb-4">
                <Lock className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-9 pr-9 py-2.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
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
              className="w-full bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg flex items-center justify-center gap-2 transition cursor-pointer"
            >
              เข้าสู่ระบบ
              <span aria-hidden="true">›</span>
            </button>

            <p className="text-center text-sm text-gray-500 mt-6">
              ยังไม่มีบัญชี?{" "}
              <Link
                to="/register"
                className="text-blue-800 font-medium hover:underline"
              >
                สมัครสมาชิกที่นี่
              </Link>
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="absolute bottom-4 left-0 right-0 text-center text-xs text-gray-400 space-y-1">
        <p>© 2024 STAX Financial Management. All Rights Reserved.</p>
        <p>
          <button className="hover:underline">Privacy Policy</button>
          {"  ·  "}
          <button className="hover:underline">Terms of Service</button>
        </p>
      </div>
    </div>
  );
}