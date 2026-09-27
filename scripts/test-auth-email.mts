// Default: DB-free normalization tests (npm test).
// Optional real-route regression: TEST_DATABASE_URL=... tsx scripts/test-auth-email.mts --database
// Use only a disposable local PostgreSQL database; migrate it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { normalizeEmail } from "../app/lib/normalize-email";

let passed = 0;
function check(condition: boolean, label: string) {
  assert.ok(condition, label);
  passed++;
  console.log(`  PASS  ${label}`);
}

async function main() {
  check(normalizeEmail("MiXeD@Example.COM") === "mixed@example.com", "mixed-case email becomes lowercase");
  check(normalizeEmail(" \t Person@Example.COM\r\n") === "person@example.com", "outer whitespace is trimmed");
  check(normalizeEmail("lower@example.com") === "lower@example.com", "canonical email stays unchanged");
  check(normalizeEmail(" \t ") === "", "blank email stays empty for route validation");
  check(normalizeEmail(" A B@Example.COM ") === "a b@example.com", "internal whitespace is not removed to bypass validation");
  check(normalizeEmail(" User+Tag@Example.COM ") === "user+tag@example.com", "plus tags are preserved");

  if (process.argv.includes("--database")) {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(databaseUrl, "TEST_DATABASE_URL is required for --database");
    const target = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a local disposable test database is allowed");
    assert.ok(target.pathname.endsWith("_test"), "database name must end in _test");
    // Set before dynamic route imports so drizzle-db never selects DATABASE_URL.
    process.env.USE_TEST_DATABASE = "1";
    assert.ok(process.env.JWT_SECRET, "set a test-only JWT_SECRET for --database");
    const { default: postgres } = await import("postgres");
    const client = postgres(databaseUrl, { max: 1 });
    const register = await import("../app/routes/api/auth/register");
    const login = await import("../app/routes/api/auth/login");
    const requestOtpRoute = await import("../app/routes/api/auth/register/request-otp");
    // Registration is OTP-gated, so the real flow must request a code first.
    // AUTH_DEV_SHOW_OTP makes the server return it, which is the only supported
    // way to obtain a code without a mail provider. The value must be the exact
    // literal "true": the gate does not trim, fold case or accept aliases, so a
    // sloppier value here would silently leave devOtp undefined and the mint
    // below would fail for a misleading reason.
    process.env.AUTH_DEV_SHOW_OTP = "true";
    const email = `auth-${randomUUID()}@test.local`;
    const password = "EmailCase!234";
    const request = (route: string, inputEmail: string, inputPassword = password, otp?: string) => new Request(
      `http://test.local/api/v1/auth/${route}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inputEmail, password: inputPassword, otp }) }
    );

    /** Register is impossible without a valid code, so always mint one first. */
    const mintOtp = async (forEmail: string): Promise<string> => {
      const res = await requestOtpRoute.action({ request: request("register/request-otp", forEmail, password) } as never);
      const body = await res.json();
      const code: string | undefined = body?.data?.devOtp;
      assert.equal(typeof code, "string", "request-otp must return a code when AUTH_DEV_SHOW_OTP is set");
      return code as string;
    };

    try {
      const otpForMixedCase = await mintOtp(` \t${email.replace("auth-", "AuTh-").replace("test.local", "Test.LOCAL")} \n`);
      const registered = await register.action({ request: request("register", ` \t${email.replace("auth-", "AuTh-").replace("test.local", "Test.LOCAL")} \n`, password, otpForMixedCase) } as never);
      const body = await registered.json();
      check(registered.status === 201 && body.data?.user?.email === email, "Register accepts mixed case and outer whitespace, returns canonical email");
      const [stored] = await client`SELECT email FROM "User" WHERE id = ${body.data.user.id}`;
      check(stored?.email === email, "Register stores the trimmed lowercase email in PostgreSQL");

      // The code is single-use: replaying the exact request must fail even though
      // the address is still valid.
      const replay = await register.action({ request: request("register", email, password, otpForMixedCase) } as never);
      check(replay.status !== 201, "a spent registration code cannot create a second account");

      for (const inputEmail of [email, email.toUpperCase(), ` \t${email.toUpperCase()}\r\n`]) {
        const response = await login.action({ request: request("login", inputEmail) } as never);
        const result = await response.json();
        check(response.status === 200 && result.success === true &&
          result.data?.user?.id === body.data.user.id && result.data?.user?.email === email &&
          typeof result.data?.accessToken === "string", "Login accepts case/whitespace variants and authenticates the registered user");
      }
      const duplicateOtp = await mintOtp(email);
      const duplicate = await register.action({ request: request("register", ` ${email.toUpperCase()} `, password, duplicateOtp) } as never);
      check(duplicate.status === 409, "case/whitespace variant cannot register a duplicate account");

      for (const [inputEmail, inputPassword] of [
        [`missing-${email}`, password], [email.toUpperCase(), "WrongPass!234"],
        [email, password.toLowerCase()], [email, ` ${password} `],
      ]) {
        const response = await login.action({ request: request("login", inputEmail, inputPassword) } as never);
        const result = await response.json();
        check(response.status === 401 && result.success === false &&
          result.message === "Invalid email or password" && !result.data?.accessToken,
          "wrong email/password rejected; password case and whitespace remain significant");
      }
      for (const action of [register.action, login.action]) {
        const response = await action({ request: request("validation", "not-an-email") } as never);
        check(response.status === 400, "invalid email format remains rejected");
      }
    } finally {
      // Only this run's random test user and its registration side effects.
      await client`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM "User" WHERE email = ${email})`;
      await client`DELETE FROM accounts WHERE user_id IN (SELECT id FROM "User" WHERE email = ${email})`;
      await client`DELETE FROM "User" WHERE email = ${email}`;
      await client.end();
    }
  } else {
    console.log("  SKIP  real-route database checks (run --database with disposable TEST_DATABASE_URL)");
  }
  console.log(`PASS: ${passed}   FAIL: 0`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
