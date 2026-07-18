import { useState, useEffect, useRef } from "react";
import { Mail, Lock, ShieldCheck,Eye, EyeOff, AlertCircle } from "lucide-react";
import { Link,useNavigate } from "react-router"
import StaxLogo from "../Login/StaxLogo";
import { useAuth } from "../../lib/auth";

const OTP_COOLDOWN_SECONDS = 60;

export default function Register() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notRobot, setNotRobot] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [otpCooldown, setOtpCooldown] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const navigate = useNavigate();
  const { register } = useAuth();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const isOtpCoolingDown = otpCooldown > 0;

  const handleSendOtp = () => {
    if (isOtpCoolingDown || !isValidEmail) return;

    // TODO: call your API to send the OTP here
    // e.g. await sendOtp(email);

    setOtpCooldown(OTP_COOLDOWN_SECONDS);
    timerRef.current = setInterval(() => {
      setOtpCooldown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleRegister = () => {
    if (!isValidEmail) {
      setErrorMessage("กรุณากรอกอีเมลให้ถูกต้อง");
      return;
    }
    if (!password || !confirmPassword) {
      setErrorMessage("กรุณากรอกรหัสผ่านให้ครบถ้วน");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage("รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน");
      return;
    }
    if (!notRobot) {
      setErrorMessage("กรุณายืนยันว่าคุณไม่ใช่โปรแกรมอัตโนมัติ");
      return;
    }
    if (!agreeTerms) {
      setErrorMessage("กรุณายอมรับข้อตกลงและนโยบายความเป็นส่วนตัว");
      return;
    }

    // TODO: ใส่ logic เรียก API ลงทะเบียนจริงตรงนี้ก่อน
    // ตอนนี้ mock ไว้ก่อนด้วยการเก็บลง localStorage ผ่าน useAuth().register
    const result = register(email, password);

    if (!result.success) {
      setErrorMessage(result.error || "ลงทะเบียนไม่สำเร็จ");
      return;
    }

    setErrorMessage("");
    navigate("/login");
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
      <div className="absolute -left-24 top-1/4 w-72 h-72 bg-emerald-100 rounded-full blur-3xl opacity-60" />
      <div className="absolute -right-24 bottom-1/4 w-72 h-72 bg-blue-100 rounded-full blur-3xl opacity-60" />

      {/* Main card */}
      <div className="relative z-10 w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden px-8 py-10 sm:px-10">
        {/* Logo */}
        <div className="flex justify-center mb-3">
          <StaxLogo width="90px" transparent compact />
        </div>
        <p className="text-center text-xs text-gray-500 mb-6">
          สร้างบัญชีผู้ใช้งานเพื่อเริ่มต้นการจัดการที่แม่นยำ
        </p>

        <div className="space-y-5">
          {/* Email with OTP */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              อีเมล (Email Address)
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errorMessage) setErrorMessage("");
                }}
                placeholder="example@stax.com"
                className="w-full pl-9 pr-28 py-2.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
              />
              <button
                type="button"
                onClick={handleSendOtp}
                disabled={isOtpCoolingDown || !isValidEmail}
                className={`absolute right-1.5 top-1/2 -translate-y-1/2 text-xs font-medium px-3 py-1.5 rounded-md transition ${
                  isOtpCoolingDown || !isValidEmail
                    ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                    : "bg-emerald-400 hover:bg-emerald-500 text-white cursor-pointer"
                }`}
              >
                {isOtpCoolingDown ? `ส่งอีกครั้งใน ${otpCooldown}s` : "ส่ง OTP"}
              </button>
            </div>
          </div>

          {/* Password */}
          <div className="relative">
            <Lock className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (errorMessage) setErrorMessage("");
              }}
              placeholder="••••••••"
              className="w-full pl-9 pr-9 py-2.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
            aria-label={showPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
          {/* Confirm Password */}
          <div className="relative">
              <ShieldCheck className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (errorMessage) setErrorMessage("");
                }}
                placeholder="••••••••"
                className="w-full pl-9 pr-9 py-2.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
          />
          <button
            type="button"
            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
            aria-label={showConfirmPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
          >
            {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
          {/* reCAPTCHA-style box */}
          <div className="flex items-center justify-between border border-gray-200 rounded-lg px-4 py-3 bg-gray-50">
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={notRobot}
                onChange={(e) => {
                  setNotRobot(e.target.checked);
                  if (errorMessage) setErrorMessage("");
                }}
                className="w-4 h-4 rounded border-gray-300 text-blue-900 focus:ring-blue-900/30"
              />
              <span className="text-sm text-gray-600">
                ฉันไม่ใช่โปรแกรมอัตโนมัติ
              </span>
            </label>
            <div className="flex flex-col items-center text-gray-300">
              <ShieldCheck className="w-6 h-6" strokeWidth={1.5} />
              <span className="text-[9px] tracking-wide">reCAPTCHA</span>
            </div>
          </div>

          {/* Terms checkbox */}
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={agreeTerms}
              onChange={(e) => {
                setAgreeTerms(e.target.checked);
                if (errorMessage) setErrorMessage("");
              }}
              className="w-4 h-4 mt-0.5 rounded border-gray-300 text-blue-900 focus:ring-blue-900/30 shrink-0"
            />
            <span className="text-sm text-gray-600 leading-relaxed">
              ยอมรับ{" "}
              <button
                type="button"
                className="text-blue-800 font-medium hover:underline"
              >
                ข้อตกลงและนโยบายความเป็นส่วนตัว
              </button>{" "}
              ของ STAX Financial
            </span>
          </label>

          {errorMessage && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-50 text-red-600 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Submit */}
          <button
            type="button"
            onClick={handleRegister}
              className="w-full bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg flex items-center justify-center gap-2 transition cursor-pointer"
          >
            ลงทะเบียนใช้งาน
            <span aria-hidden="true">→</span>
          </button>
          <p className="text-center text-sm text-gray-500">
            มีบัญชีอยู่แล้ว?{" "}
            <Link
              to="/login"
              className="text-blue-800 font-medium hover:underline"
            >
              เข้าสู่ระบบ
            </Link>
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="absolute bottom-4 left-0 right-0 text-center text-xs text-gray-400 space-y-1">
        <p>© 2024 STAX Financial Management. All Rights Reserved.</p>
        <p>
          <button className="hover:underline">Support</button>
          {"  ·  "}
          <button className="hover:underline">Docs</button>
        </p>
      </div>
    </div>
  );
}