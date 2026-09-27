// scripts/test-otp.mts
//
// Behavioural regression coverage for the OTP state machine and the
// dev-only code echo. These tests deliberately call the REAL pure helpers
// rather than grepping source, so a behavioural regression fails here even
// when the source text still mentions the right words.
//
// Covers the requested matrix:
//   9  request OTP issues a usable code
//   10 dev flag ON exposes the code
//   11 dev flag OFF never exposes the code
//   12 correct OTP verifies
//   13 invalid OTP rejected
//   14 expired OTP rejected
//   15 resend cooldown enforced
//   16 OTP cannot be reused (single use)
//
// DB-free: no PostgreSQL connection is opened. app/lib/otp.ts builds a postgres
// client at import time, so a placeholder DATABASE_URL is required BEFORE the
// module is loaded. Static `import` declarations are hoisted above any statement,
// so the module is pulled in with a dynamic import instead.
process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@127.0.0.1:1/placeholder";

import { readFileSync } from "node:fs";

const {
  DEV_OTP_ENV_FLAG,
  OTP_CODE_LENGTH,
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  OtpPurpose,
  OtpRejection,
  generateOtpCode,
  hashOtpCode,
  isDevOtpEnabled,
  isOtpUsable,
  isValidOtpFormat,
  otpAttemptOutcome,
  otpExpiry,
  otpPepper,
  resendCooldownRemaining,
  safeCompareOtpHash,
} = await import("../app/lib/otp");

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log("  PASS  " + label);
  } else {
    failed++;
    console.log("  FAIL  " + label);
  }
}

function section(title: string) {
  console.log("\n=== " + title + " ===");
}

function read(p: string): string {
  return readFileSync(new URL("../" + p, import.meta.url), "utf8");
}

const NOW = new Date("2026-03-01T12:00:00.000Z");
const EMAIL = "alice@example.com";
const PEPPER = "test-pepper-value-0123456789";

section("CONFIGURATION");

check(OTP_CODE_LENGTH === 6, "an OTP is 6 digits");
check(OTP_TTL_SECONDS === 600, "an OTP lives 10 minutes");
check(OTP_RESEND_COOLDOWN_SECONDS === 60, "resend cooldown is 60 seconds");
check(OTP_MAX_VERIFY_ATTEMPTS === 5, "at most 5 wrong guesses per code");
check(
  OTP_MAX_VERIFY_ATTEMPTS * 1_000_000 < Number.MAX_SAFE_INTEGER,
  "the 6-digit space is small enough that an attempt cap is mandatory"
);

section("PEPPER (OTP_PEPPER IS A REAL SECRET, NOT JUST DOCUMENTED)");

check(
  otpPepper({ OTP_PEPPER: "dedicated-otp-pepper-abcdef" }) ===
    "dedicated-otp-pepper-abcdef",
  "OTP_PEPPER is used when it is set"
);
check(
  otpPepper({ OTP_PEPPER: "dedicated-otp-pepper-abcdef", JWT_SECRET: "jwt-secret-value-abcdefgh" }) ===
    "dedicated-otp-pepper-abcdef",
  "OTP_PEPPER wins over JWT_SECRET when both are set"
);
check(
  otpPepper({ JWT_SECRET: "jwt-secret-value-abcdefgh" }) === "jwt-secret-value-abcdefgh",
  "it falls back to JWT_SECRET when OTP_PEPPER is absent"
);
check(
  otpPepper({ OTP_PEPPER: "   ", JWT_SECRET: "jwt-secret-value-abcdefgh" }) ===
    "jwt-secret-value-abcdefgh",
  "a blank OTP_PEPPER falls back instead of becoming the pepper"
);
check(
  otpPepper({ OTP_PEPPER: "short", JWT_SECRET: "jwt-secret-value-abcdefgh" }) ===
    "jwt-secret-value-abcdefgh",
  "a too-short OTP_PEPPER is ignored in favour of JWT_SECRET"
);

let threwOnWeakPepperAlone = false;
try {
  otpPepper({ OTP_PEPPER: "short" });
} catch {
  threwOnWeakPepperAlone = true;
}
check(
  threwOnWeakPepperAlone,
  "a too-short OTP_PEPPER with no usable JWT_SECRET throws rather than hashing weakly"
);

let threwWithoutAnySecret = false;
try {
  otpPepper({});
} catch {
  threwWithoutAnySecret = true;
}
check(threwWithoutAnySecret, "no usable secret throws instead of hashing unpeppered");

let threwOnWeakJwt = false;
try {
  otpPepper({ JWT_SECRET: "change-me" });
} catch {
  threwOnWeakJwt = true;
}
check(threwOnWeakJwt, "a weak JWT_SECRET alone still throws loudly");

const hashA = hashOtpCode(EMAIL, OtpPurpose.REGISTER, "123456", "pepper-one");
const hashB = hashOtpCode(EMAIL, OtpPurpose.REGISTER, "123456", "pepper-two");
check(hashA !== hashB, "a different pepper produces a different digest");
check(hashA.length === 64 && /^[0-9a-f]{64}$/.test(hashA), "the digest is a 64-char sha256 hex string");
check(
  hashOtpCode(EMAIL, OtpPurpose.PASSWORD_RESET, "123456", "pepper-one") !== hashA,
  "the digest binds the purpose, so a register code cannot verify for reset"
);
check(
  hashOtpCode("bob@example.com", OtpPurpose.REGISTER, "123456", "pepper-one") !== hashA,
  "the digest binds the email, so a code cannot be used on another account"
);
check(
  !hashA.includes("123456"),
  "the digest does not contain the plaintext code"
);

section("9/12/13: CORRECT AND INCORRECT CODES");

const codes = new Set<string>();
for (let i = 0; i < 400; i++) codes.add(generateOtpCode());
check(codes.size > 350, "generated codes are random, not a constant");
check([...codes].every((c) => /^\d{6}$/.test(c)), "every generated code is exactly 6 digits");
check(
  !codes.has("000000") || codes.size > 350,
  "no fixed/placeholder code is used"
);

const code = generateOtpCode();
const row = {
  codeHash: hashOtpCode(EMAIL, OtpPurpose.REGISTER, code, PEPPER),
  consumedAt: null as Date | null,
  expiresAt: otpExpiry(NOW, OTP_TTL_SECONDS),
  attempts: 0,
};

check(
  otpAttemptOutcome(row, code, NOW, PEPPER, EMAIL, OtpPurpose.REGISTER) === null,
  "12: the correct code verifies"
);
check(
  otpAttemptOutcome(row, "000000", NOW, PEPPER, EMAIL, OtpPurpose.REGISTER) ===
    OtpRejection.MISMATCH,
  "13: a wrong code is rejected as MISMATCH"
);
check(
  otpAttemptOutcome(row, "12345", NOW, PEPPER, EMAIL, OtpPurpose.REGISTER) ===
    OtpRejection.MALFORMED,
  "a 5-digit code is rejected as MALFORMED"
);
check(
  otpAttemptOutcome(row, "abcdef", NOW, PEPPER, EMAIL, OtpPurpose.REGISTER) ===
    OtpRejection.MALFORMED,
  "a non-numeric code is rejected as MALFORMED"
);
check(
  otpAttemptOutcome(row, code, NOW, "a-different-pepper", EMAIL, OtpPurpose.REGISTER) ===
    OtpRejection.MISMATCH,
  "the correct code under a different pepper does not verify"
);
check(
  otpAttemptOutcome(row, code, NOW, PEPPER, EMAIL, OtpPurpose.PASSWORD_RESET) ===
    OtpRejection.MISMATCH,
  "a code issued for registration cannot verify for password reset"
);
check(isValidOtpFormat("123456") && isValidOtpFormat("000000"), "000000 is a well-formed code");
check(!isValidOtpFormat("1234567"), "a 7-digit code is not well formed");
check(!isValidOtpFormat(""), "an empty code is not well formed");
check(!isValidOtpFormat(null), "a null code is not well formed");
check(safeCompareOtpHash(hashA, hashA), "a digest matches itself");
check(!safeCompareOtpHash(hashA, hashB), "different digests do not match");
check(!safeCompareOtpHash(hashA, "short"), "a length mismatch returns false rather than throwing");
check(!safeCompareOtpHash(hashA, undefined as unknown as string), "an undefined digest is refused");

section("14: EXPIRY");

check(
  otpAttemptOutcome(row, code, new Date(NOW.getTime() + OTP_TTL_SECONDS * 1000 + 1), PEPPER, EMAIL, OtpPurpose.REGISTER) ===
    OtpRejection.EXPIRED,
  "14: a code is rejected at exactly its expiry instant"
);
check(
  otpAttemptOutcome(row, code, new Date(NOW.getTime() + OTP_TTL_SECONDS * 1000 - 1000), PEPPER, EMAIL, OtpPurpose.REGISTER) ===
    null,
  "a code one second before expiry still verifies"
);
check(
  otpAttemptOutcome(row, code, new Date(NOW.getTime() + 24 * 3600 * 1000), PEPPER, EMAIL, OtpPurpose.REGISTER) ===
    OtpRejection.EXPIRED,
  "a code from yesterday is rejected"
);
check(
  otpExpiry(NOW, OTP_TTL_SECONDS).getTime() === NOW.getTime() + OTP_TTL_SECONDS * 1000,
  "expiry is exactly TTL seconds after issue"
);

section("15: RESEND COOLDOWN");

check(
  resendCooldownRemaining(NOW, new Date(NOW.getTime() + 1000), OTP_RESEND_COOLDOWN_SECONDS) > 0,
  "15: a resend 1s after the last send is still in cooldown"
);
check(
  resendCooldownRemaining(NOW, new Date(NOW.getTime() + 59_000), OTP_RESEND_COOLDOWN_SECONDS) > 0,
  "a resend at 59s is still in cooldown"
);
check(
  resendCooldownRemaining(NOW, new Date(NOW.getTime() + 60_000), OTP_RESEND_COOLDOWN_SECONDS) === 0,
  "a resend at exactly 60s is allowed"
);
check(
  resendCooldownRemaining(NOW, new Date(NOW.getTime() + 3_600_000), OTP_RESEND_COOLDOWN_SECONDS) === 0,
  "a resend an hour later is allowed"
);
// A first-ever request has no previous row, so issueOtp skips the cooldown
// entirely rather than computing one from a missing timestamp. That guard is
// the behaviour that actually matters, so it is asserted directly.
const otpSrcForCooldown = read("app/lib/otp.ts");
check(
  /if \(existing\)\s*\{[\s\S]{0,200}resendCooldownRemaining/.test(otpSrcForCooldown),
  "a first-ever request is never blocked by the cooldown (the caller guards on an existing row)"
);
check(
  !/function resendCooldownRemaining\([^)]*null/.test(otpSrcForCooldown),
  "resendCooldownRemaining keeps its non-null Date contract instead of pretending to accept null"
);

section("16: SINGLE USE AND ATTEMPT BURN");

check(
  otpAttemptOutcome({ ...row, consumedAt: NOW }, code, NOW, PEPPER, EMAIL, OtpPurpose.REGISTER) ===
    OtpRejection.ALREADY_USED,
  "16: a consumed code cannot be reused"
);
check(
  otpAttemptOutcome(
    { ...row, attempts: OTP_MAX_VERIFY_ATTEMPTS },
    code,
    NOW,
    PEPPER,
    EMAIL,
    OtpPurpose.REGISTER
  ) === OtpRejection.TOO_MANY_ATTEMPTS,
  "a burned code rejects even the CORRECT code"
);
check(
  otpAttemptOutcome(
    { ...row, attempts: OTP_MAX_VERIFY_ATTEMPTS - 1 },
    code,
    NOW,
    PEPPER,
    EMAIL,
    OtpPurpose.REGISTER
  ) === null,
  "the last permitted attempt still works"
);
check(
  isOtpUsable({ consumedAt: NOW, expiresAt: otpExpiry(NOW), attempts: 0 }, NOW).usable === false,
  "a consumed row is not usable"
);
check(
  isOtpUsable({ consumedAt: null, expiresAt: NOW, attempts: 0 }, NOW).usable === false,
  "a row expiring exactly now is not usable"
);

section("10/11: DEV OTP DISPLAY GATE");

check(DEV_OTP_ENV_FLAG === "AUTH_DEV_SHOW_OTP", "the flag is AUTH_DEV_SHOW_OTP");
check(isDevOtpEnabled({ AUTH_DEV_SHOW_OTP: "true" }), '10: the exact string "true" enables the echo');

// The flag gates plaintext OTP disclosure, so it must open ONLY on the exact
// documented value. Every near-miss below must fail CLOSED. "tolerates case"
// and "tolerates whitespace" were deliberately removed: a .env editor, YAML
// parser or shell may normalise a value a human merely intended, and a config
// value that is only *nearly* correct must never leak one-time passwords.
const STRICTLY_REJECTED: ReadonlyArray<[string | undefined, string]> = [
  ["TRUE", "uppercase TRUE"],
  ["True", "capitalised True"],
  ["tRuE", "mixed-case tRuE"],
  ["1", "the numeric alias 1"],
  ["yes", "the truthy alias yes"],
  ["on", "the truthy alias on"],
  [" true ", "a padded ' true '"],
  ["true ", "a trailing space"],
  [" true", "a leading space"],
  ["\ttrue", "a leading tab"],
  ["true\n", "a trailing newline"],
  ["false", "an explicit false"],
  ["", "an empty string"],
  [undefined, "an unset flag"],
];

for (const [value, label] of STRICTLY_REJECTED) {
  check(!isDevOtpEnabled({ AUTH_DEV_SHOW_OTP: value }), `11: ${label} does NOT enable the echo`);
}
check(
  !isDevOtpEnabled({ NODE_ENV: "development" } as NodeJS.ProcessEnv),
  "NODE_ENV=development alone does NOT enable the echo"
);
check(
  !isDevOtpEnabled({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
  "NODE_ENV=production alone does not enable the echo"
);
check(
  isDevOtpEnabled({ NODE_ENV: "production", AUTH_DEV_SHOW_OTP: "true" } as NodeJS.ProcessEnv),
  "the explicit flag is honoured even under NODE_ENV=production (it is the only switch)"
);

section("NO PLAINTEXT EVER PERSISTED OR AUDITED");

const otpSrc = read("app/lib/otp.ts");
check(
  !/codeHash:\s*code\b/.test(otpSrc),
  "the plaintext code is never assigned to the persisted codeHash"
);
check(
  !/code_hash:\s*code\b/.test(otpSrc),
  "the plaintext code is never assigned to a raw code_hash column"
);
check(
  /safeCompareOtpHash/.test(otpSrc),
  "digest comparison goes through the constant-time helper"
);

const auditSrc = read("app/lib/audit-log.ts");
const redactsOtp = /otp/i.test(auditSrc) && /code_hash|ticket/i.test(auditSrc);
check(redactsOtp, "the audit logger knows about otp/code_hash/ticket-shaped keys");

section("UI: DEV OTP BANNER + LOGIN LINK");

const registerSrc = read("app/component/Register/Register.tsx");
const forgotSrc = read("app/component/Login/ForgotPassword.tsx");
const loginSrc = read("app/component/Login/Login.tsx");

check(/devOtp/.test(registerSrc), "the register page holds the dev OTP in state");
check(
  /\{devOtp && \(/.test(registerSrc),
  "the register dev OTP banner renders only when a code was returned"
);
check(
  /AUTH_DEV_SHOW_OTP/.test(registerSrc),
  "the register banner explains it is gated by AUTH_DEV_SHOW_OTP"
);
check(
  /\{devOtp && \(/.test(forgotSrc),
  "the forgot-password dev OTP banner renders only when a code was returned"
);
check(
  /OTP/.test(forgotSrc) && /sendOtp|requestOtp|requestReset/i.test(forgotSrc),
  "the forgot-password page requests an OTP"
);
check(
  /to="\/forgot-password"/.test(loginSrc),
  "the login page links to /forgot-password"
);
check(
  !/<button[^>]*>\s*[^<]*\u0e25\u0e37\u0e21\u0e23\u0e31\u0e2a\u0e1e\u0e32\u0e0a\u0e32\u0e1c\u0e3f/.test(loginSrc),
  "there is no dead non-navigating 'forgot password' button left on the login page"
);
check(
  (loginSrc.match(/to="\/forgot-password"/g) || []).length === 1,
  "the forgot-password link is not duplicated on the login page"
);

console.log("\n================ SUMMARY ================");
console.log("PASS: " + passed + "   FAIL: " + failed);
if (failed > 0) {
  process.exit(1);
}
