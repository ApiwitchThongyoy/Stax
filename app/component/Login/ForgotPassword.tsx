import { useState, useEffect, useRef } from "react";
import { Link } from "react-router";
import {
  Mail,
  Lock,
  KeyRound,
  ShieldCheck,
  Eye,
  EyeOff,
  AlertCircle,
  Info,
  CheckCircle2,
} from "lucide-react";
import StaxLogo from "../Login/StaxLogo";
import { useAuth } from "../../lib/auth";

/**
 * Password recovery.
 *
 * Three steps, each of which the server enforces independently:
 *   1. request a one-time code for an email address,
 *   2. enter that code to obtain a short-lived reset ticket,
 *   3. choose a new password, which the server accepts only with the ticket.
 *
 * The page mirrors the Login/Register card layout deliberately — this is the same
 * entry point into the same system, and a user who lands here is mid-flow, not
 * exploring.
 *
 * Two privacy decisions are visible in the copy, and they matter:
 *   - Step 1 never says whether the address is registered. The server answers
 *     identically either way so this form cannot be used to enumerate accounts.
 *   - Step 2 reports only that the code was wrong or expired, never how close it
 *     was, so it cannot be brute-forced for information.
 *
 * On success the server revokes EVERY session for that account (the password
 * changed, so any token minted from the old one must die), and this page sends
 * the user to the login form with a notice — signing them back in automatically
 * would hide that their other devices were logged out.
 */

const OTP_COOLDOWN_SECONDS = 60;
const OTP_CODE_LENGTH = 6;

type Step = "request" | "verify";

export default function ForgotPassword() {
  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otpCooldown, setOtpCooldown] = useState(0);
  const [devOtp, setDevOtp] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [done, setDone] = useState(false);

  const { requestOtp, resetPassword } = useAuth();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const isOtpCoolingDown = otpCooldown > 0;
  const isOtpValid = new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`).test(otp);

  const startCooldown = (seconds: number) => {
    setOtpCooldown(seconds);
    if (timerRef.current) clearInterval(timerRef.current);
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

  const handleRequestOtp = async () => {
    if (isOtpCoolingDown || !isValidEmail || sendingOtp) return;

    setSendingOtp(true);
    setErrorMessage("");
    setNoticeMessage("");

    const result = await requestOtp(email, "password-reset");
    setSendingOtp(false);

    if (!result.success) {
      setErrorMessage(result.error || "ไม่สามารถส่งรหัสยืนยันได้");
      return;
    }

    setStep("verify");
    setDevOtp(result.devOtp ?? "");
    startCooldown(result.retryAfterSeconds ?? OTP_COOLDOWN_SECONDS);
    setNoticeMessage(
      "หากอีเมลนี้มีบัญชีอยู่ รหัสยืนยันจะถูกส่งไปยังอีเมลนั้น (รหัสมีอายุ 10 นาที)"
    );
  };

  const handleReset = async () => {
    if (!isOtpValid) {
      setErrorMessage(`กรุณากรอกรหัสยืนยัน ${OTP_CODE_LENGTH} หลัก`);
      return;
    }
    if (newPassword.length < 8) {
      setErrorMessage("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage("รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน");
      return;
    }

    setSubmitting(true);
    setErrorMessage("");

    const result = await resetPassword(email, otp, newPassword);
    setSubmitting(false);

    if (!result.success) {
      setErrorMessage(result.error || "เปลี่ยนรหัสผ่านไม่สำเร็จ");
      return;
    }

    setDone(true);
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 relative overflow-hidden p-4">
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(circle, #d1d5db 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      />

      <div className="absolute -left-24 top-1/4 w-72 h-72 bg-emerald-100 rounded-full blur-3xl opacity-60" />
      <div className="absolute -right-24 bottom-1/4 w-72 h-72 bg-blue-100 rounded-full blur-3xl opacity-60" />

      <div className="relative z-10 w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden px-8 py-10 sm:px-10">
        <div className="flex justify-center mb-3">
          <StaxLogo width="90px" transparent compact />
        </div>
        <p className="text-center text-xs text-gray-500 mb-6">
          {done
            ? "เปลี่ยนรหัสผ่านเรียบร้อยแล้ว"
            : "กู้คืนการเข้าถึงบัญชีของคุณด้วยรหัสยืนยันทางอีเมล"}
        </p>

        {done ? (
          <div className="space-y-5">
            <div className="flex items-start gap-2 px-3 py-3 rounded-lg bg-emerald-50 text-emerald-700 text-sm">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว
                <br />
                <span className="text-xs">
                  เซสชันเดิมทั้งหมดของบัญชีนี้ถูกปิดเพื่อความปลอดภัย
                  กรุณาเข้าสู่ระบบใหม่ด้วยรหัสผ่านใหม่
                </span>
              </span>
            </div>
            <Link
              to="/login"
              className="w-full bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg flex items-center justify-center gap-2 transition"
            >
              ไปหน้าเข้าสู่ระบบ
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        ) : (
          <div className="space-y-5">
            {step === "request" ? (
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
                    className="w-full pl-9 pr-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="px-3 py-2 rounded-lg bg-gray-50 text-xs text-gray-600">
                  กำลังกู้คืนบัญชีของ{" "}
                  <span className="font-medium text-gray-900">{email}</span>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    รหัสยืนยัน (OTP)
                  </label>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={OTP_CODE_LENGTH}
                      value={otp}
                      onChange={(e) => {
                        setOtp(
                          e.target.value.replace(/\D/g, "").slice(0, OTP_CODE_LENGTH)
                        );
                        if (errorMessage) setErrorMessage("");
                      }}
                      placeholder={`${OTP_CODE_LENGTH} หลัก`}
                      className="w-full pl-9 pr-3 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition tracking-[0.3em]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleRequestOtp}
                    disabled={isOtpCoolingDown || sendingOtp}
                    className={`mt-2 text-xs font-medium transition ${
                      isOtpCoolingDown || sendingOtp
                        ? "text-gray-400 cursor-not-allowed"
                        : "text-blue-800 hover:underline cursor-pointer"
                    }`}
                  >
                    {sendingOtp
                      ? "กำลังส่ง..."
                      : isOtpCoolingDown
                        ? `ส่งรหัสใหม่ได้ใน ${otpCooldown}s`
                        : "ส่งรหัสใหม่"}
                  </button>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    รหัสผ่านใหม่
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type={showPassword ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => {
                        setNewPassword(e.target.value);
                        if (errorMessage) setErrorMessage("");
                      }}
                      placeholder="อย่างน้อย 8 ตัวอักษร"
                      className="w-full pl-9 pr-9 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                      aria-label={showPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
                    >
                      {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    ยืนยันรหัสผ่านใหม่
                  </label>
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
                      className="w-full pl-9 pr-9 py-2.5 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                      aria-label={
                        showConfirmPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"
                      }
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              </>
            )}

            {errorMessage && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-50 text-red-600 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            )}

            {noticeMessage && !errorMessage && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-emerald-50 text-emerald-700 text-sm">
                <Mail className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{noticeMessage}</span>
              </div>
            )}

            {devOtp && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 text-amber-800 text-sm border border-amber-200">
                <Info className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong>โหมดนักพัฒนา</strong> — รหัสยืนยันของคุณคือ{" "}
                  <strong className="font-mono tracking-widest">{devOtp}</strong>
                  <br />
                  <span className="text-xs">
                    รหัสนี้จะแสดงเฉพาะเมื่อเปิดใช้งาน AUTH_DEV_SHOW_OTP
                    เท่านั้น
                  </span>
                </span>
              </div>
            )}

            {step === "request" ? (
              <button
                type="button"
                onClick={handleRequestOtp}
                disabled={!isValidEmail || isOtpCoolingDown || sendingOtp}
                className="w-full bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {sendingOtp ? "กำลังส่งรหัส..." : "ส่งรหัสยืนยัน"}
                <span aria-hidden="true">→</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleReset}
                disabled={submitting}
                className="w-full bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium py-2.5 rounded-lg flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {submitting ? "กำลังตั้งรหัสผ่านใหม่..." : "ตั้งรหัสผ่านใหม่"}
                <span aria-hidden="true">→</span>
              </button>
            )}

            <p className="text-center text-sm text-gray-500">
              <button
                type="button"
                onClick={() => {
                  setStep("request");
                  setOtp("");
                  setNewPassword("");
                  setConfirmPassword("");
                  setErrorMessage("");
                  setNoticeMessage("");
                  setDevOtp("");
                }}
                className="text-blue-800 font-medium hover:underline"
              >
                เริ่มต้นใหม่
              </button>
              <span className="mx-2 text-gray-300">·</span>
              <Link
                to="/login"
                className="text-blue-800 font-medium hover:underline"
              >
                กลับไปเข้าสู่ระบบ
              </Link>
            </p>
          </div>
        )}
      </div>

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
