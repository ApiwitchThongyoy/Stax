// Pure rate-limit helpers (no DB dependency — safe for unit tests).
// Re-exported by rate-limit.ts which adds the DB helpers.

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export interface AuthRateLimitConfig {
  windowMs: number;
  maxAttempts: number;
}

export const LOGIN_EMAIL_RATE_LIMIT: AuthRateLimitConfig = {
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxAttempts: 5,
};

export const LOGIN_IP_RATE_LIMIT: AuthRateLimitConfig = {
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxAttempts: 20,
};

export const REGISTER_IP_RATE_LIMIT: AuthRateLimitConfig = {
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxAttempts: 10,
};

export const RATE_LIMIT_PURGE_CHANCE = 1 / 50;
export const RATE_LIMIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Key builders + client IP extraction (pure)
// ---------------------------------------------------------------------------

const IP_VALID_CHARS = /^[A-Za-z0-9:.\-\[\]%_]+$/;
const MAX_IP_LEN = 64;

export function loginIpKey(ip: string): string {
  return `login-ip:${ip}`;
}

export function loginEmailKey(email: string): string {
  return `login-email:${email}`;
}

/**
 * Register-budget key: per-IP ONLY. Deliberately does NOT embed the email —
 * a per-IP (per-IP-per-email) bucket keyed on ip+email would let an attacker
 * rotate emails from one IP and get a fresh bucket every time, bypassing the
 * REGISTER_IP_RATE_LIMIT cap. The namespace prefix (register- vs login-) keeps
 * register and login budgets orthogonal even though both are per-IP.
 */
export function registerIpKey(ip: string): string {
  return `register-ip:${ip}`;
}

/**
 * Best-effort client IP extraction from a Request's forwarding headers.
 * Iterates x-forwarded-for (first comma-segment), x-real-ip,
 * cf-connecting-ip; returns the first value that is sane. Cross-client
 * headers are never trusted: only a bounded safe-charset value is kept, and
 * anything unusable collapses to the literal "unknown" so a client can't
 * spray arbitrary strings into the rate-limit table or bypass the IP caps.
 */
export function clientIpFromRequest(request: Request): string {
  const candidates = [
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "",
    request.headers.get("x-real-ip")?.trim() ?? "",
    request.headers.get("cf-connecting-ip")?.trim() ?? "",
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      candidate.length <= MAX_IP_LEN &&
      IP_VALID_CHARS.test(candidate)
    ) {
      return candidate;
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

export interface RateLimitCheck {
  limited: boolean;
  windowStartedAt: number;
  attempts: number;
  retryAfterMs: number;
}

function nowMs(): number {
  return Date.now();
}

/**
 * Pure decision: given the current window's start and attempt count, decide
 * whether the request is limited, and how long to wait. DB-free so tests can
 * pin the boundary math exactly.
 *
 * Semantics (post-increment): `attempts` is the current request's OWN
 * post-increment count — the caller increments the DB bucket BEFORE evaluating
 * (incrementRateLimit returns attempts AFTER counting this request), so
 * `attempts` INCLUDES this request. Limited (429) iff attempts > maxAttempts.
 * A window that has expired resets to attempts=0 (allowed).
 *
 * Boundary with maxAttempts = 5:
 *   - attempts 1..5 -> allowed. attempt #5 (attempts === max) is the LAST
 *     allowed request.
 *   - attempts >= 6 -> limited (429). attempt #6 is the first 429.
 *
 * The login route increments BOTH keys (IP + email) before evaluating, so a
 * 429 is returned without wasting a bcrypt round; a successful login clears
 * only the EMAIL bucket and rolls back its OWN IP-bucket attempt — prior IP
 * failures (credential-spray protection) are preserved. The register route
 * increments the per-IP register key (no email in the key) before evaluating.
 */
export function evaluateRateLimit(
  config: AuthRateLimitConfig,
  windowStartedAt: number,
  attempts: number,
  now: number = nowMs()
): RateLimitCheck {
  if (now - windowStartedAt >= config.windowMs) {
    return {
      limited: false,
      windowStartedAt: now,
      attempts: 0,
      retryAfterMs: 0,
    };
  }
  const over = Math.max(0, attempts - config.maxAttempts);
  const limited = over > 0;
  return {
    limited,
    windowStartedAt,
    attempts,
    retryAfterMs: limited
      ? Math.max(0, config.windowMs - (now - windowStartedAt))
      : 0,
  };
}

// ---------------------------------------------------------------------------
// Rate limit 429 response (pure — no DB, no crypto)
// ---------------------------------------------------------------------------

/**
 * 429 response with informative-but-safe headers. The body message is generic
 * ("Too many attempts...") so a login 429 never reveals whether the specific
 * email even exists — both email and IP buckets produce the same body.
 */
export function rateLimitResponse(
  retryAfterSeconds: number,
  limit: number,
  remaining: number
): Response {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(Math.max(0, remaining)),
  };
  const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds / 1000));
  headers["Retry-After"] = String(retryAfter);
  return Response.json(
    {
      success: false,
      message: "Too many attempts. Please try again later.",
      code: "TOO_MANY_ATTEMPTS",
      retryAfterSeconds: retryAfter,
    },
    { status: 429, headers }
  );
}