// W1-1 — Server-only Gemini integration for structured statement extraction.
//
// Gemini is used ONLY for structured extraction/analysis of statement text into
// a typed shape. It is deliberately NOT used to calculate tax (tax is handled by
// the deterministic Decimal Core Engine in ./tax-engine.ts).
//
// This module is server-only. It reads GEMINI_API_KEY / GEMINI_MODEL from the
// process environment and never exposes those values to browser code.
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

/**
 * Default model used when GEMINI_MODEL is not configured in the environment.
 * This is a documented server-side default constant — never a credential.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

export const GeminiErrorCode = {
  NOT_CONFIGURED: "GEMINI_NOT_CONFIGURED",
  REQUEST_FAILED: "GEMINI_REQUEST_FAILED",
  INVALID_RESPONSE: "GEMINI_INVALID_RESPONSE",
  SCHEMA_VALIDATION_FAILED: "GEMINI_SCHEMA_VALIDATION_FAILED",
} as const;

export type GeminiErrorCodeValue =
  (typeof GeminiErrorCode)[keyof typeof GeminiErrorCode];

/**
 * Sanitized downstream failure summary attached to a request failure so the
 * real cause is preserved for server logs without leaking secrets. Only
 * whitelisted fields are kept (never the API key, auth headers, or request URL).
 */
export interface GeminiRequestFailure {
  /** Upstream error constructor name, e.g. "TypeError" or "SDKStatusError". */
  type: string;
  /** HTTP status when the upstream error carries one (e.g. 429, 400). */
  status?: number;
  /** Low-level cause code, e.g. ENOTFOUND / ECONNRESET / ETIMEDOUT. */
  code?: string;
}

export class GeminiError extends Error {
  readonly code: GeminiErrorCodeValue;
  readonly cause?: GeminiRequestFailure;
  constructor(
    code: GeminiErrorCodeValue,
    message: string,
    cause?: GeminiRequestFailure
  ) {
    super(message);
    this.name = "GeminiError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Walk an unknown upstream error and extract ONLY the whitelisted, sanitized
 * fields we are safe to log: the error type name, an HTTP status if present, and
 * the lowest-level cause code (ENOTFOUND / ECONNRESET / ETIMEDOUT / UND_ERR_*).
 * Never includes raw messages, URLs, headers, or credentials.
 */
export function classifyGeminiRequestFailure(error: unknown): GeminiRequestFailure {
  const failure: GeminiRequestFailure = {
    type: error instanceof Error ? error.constructor.name : "Unknown",
  };

  if (typeof error === "object" && error !== null) {
    const status = (error as Record<string, unknown>).status;
    if (typeof status === "number" && status >= 100 && status <= 599) {
      failure.status = status;
    }
  }

  // undici / Node fetch attach the real network error under `cause.code`
  // (e.g. ENOTFOUND, ECONNRESET, ETIMEDOUT, UND_ERR_HEADERS_TIMEOUT).
  let cursor: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(typeof cursor === "object" && cursor !== null)) break;
    const code = (cursor as Record<string, unknown>).code;
    if (typeof code === "string" && code.length > 0) {
      failure.code = code;
      break;
    }
    cursor = (cursor as Record<string, unknown>).cause;
  }

  return failure;
}

// ---------------------------------------------------------------------------
// Structured schema (used for local validation with Zod).
//
// TransactionCategory mirrors the existing STAX transaction categories used in
// the current statement pipeline (pdfStatementParser.TransactionCategory) so the
// extracted result maps cleanly to the rest of the system. Monetary decimal
// values coming from the AI are kept as STRINGS — never Number (no float money).
// ---------------------------------------------------------------------------
export const transactionCategorySchema = z.enum([
  "income",
  "expense",
  "equity",
  "asset",
]);

// Validates a canonical decimal string that is a finite, non-NaN decimal.
// Rejects empty, "NaN", "Infinity", "-Infinity", and malformed numbers.
const decimalStringSchema = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, "must be a valid finite decimal string");

// Normalizes a finite JSON number to its canonical decimal string form. Gemini
// structured output sometimes emits monetary values as numbers despite the
// STRING contract (model-dependent). Accepting the number is a compatibility
// normalization, NOT a validation weakening: the decimal regex still rejects
// any malformed value after coercion. Null/undefined/missing pass through.
function moneyAsDecimalString(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return v;
}

// Normalizes a numeric string (e.g. "0.9") into a number for confidence, and
// passes through real numbers and null/undefined.
function percentAsNumber(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return v;
}

const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((v) => {
    const dt = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === v;
  }, "must be a real calendar date");

const geminiTransactionSchema = z
  .object({
    transactionDate: isoDateSchema,
    description: z.string().trim().min(1).max(500),
    transactionType: transactionCategorySchema,
    currency: z
      .string()
      .trim()
      .transform((c) => c.toUpperCase())
      .pipe(
        z
          .string()
          .regex(/^[A-Z]{2,3}$/, "currency must be 2-3 uppercase letters")
      ),
    amount: z.preprocess(moneyAsDecimalString, decimalStringSchema),
    exchangeRate: z
      .preprocess(moneyAsDecimalString, decimalStringSchema)
      .nullable()
      .optional(),
    amountThb: z
      .preprocess(moneyAsDecimalString, decimalStringSchema)
      .nullable()
      .optional(),
    confidence: z
      .preprocess(percentAsNumber, z.number().min(0).max(1))
      .nullable()
      .optional(),
  })
  .strict();

export const geminiStatementSchema = z
  .object({
    statement: z
      .object({
        transactions: z.array(geminiTransactionSchema).max(500),
        warnings: z.array(z.string()).default([]),
      })
      .strict(),
  })
  .strict();

export type GeminiTransaction = z.infer<typeof geminiTransactionSchema>;
export type GeminiStatementResult = z.infer<typeof geminiStatementSchema>;

// ---------------------------------------------------------------------------
// Gemini structured-output JSON schema (sent to the model via responseSchema).
// Mirrors the Zod schema so the model returns JSON we can validate locally.
// ---------------------------------------------------------------------------
export const GEMINI_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    statement: {
      type: "OBJECT",
      properties: {
        transactions: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              transactionDate: { type: "STRING", description: "YYYY-MM-DD" },
              description: { type: "STRING" },
              transactionType: {
                type: "STRING",
                enum: ["income", "expense", "equity", "asset"],
              },
              currency: { type: "STRING", description: "ISO 4217 code, uppercase" },
              amount: { type: "STRING", description: "decimal string" },
              exchangeRate: { type: "STRING", nullable: true },
              amountThb: { type: "STRING", nullable: true },
              confidence: { type: "NUMBER", nullable: true },
            },
            required: [
              "transactionDate",
              "description",
              "transactionType",
              "currency",
              "amount",
            ],
          },
        },
        warnings: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["transactions"],
    },
  },
  required: ["statement"],
};

export interface GeminiParseOutcome {
  ok: true;
  result: GeminiStatementResult;
  model: string;
}

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

/** Resolve the model name from env, falling back to the documented default. */
export function resolveGeminiModel(): string {
  const model = process.env.GEMINI_MODEL;
  return model && model.trim().length > 0 ? model.trim() : DEFAULT_GEMINI_MODEL;
}

function buildPrompt(statementText: string): string {
  return [
    "You are an assistant that extracts structured transaction data from broker " +
      "statement text for the STAX tax application.",
    "Analyze the statement text and return the transactions you can identify with " +
      "high confidence. Use STRING values for all monetary amounts (never JSON numbers).",
    "Rules:",
    "- transactionDate must be YYYY-MM-DD (real calendar date).",
    "- currency must be an uppercase ISO 4217 code (2-3 letters).",
    "- transactionType must be one of: income, expense, equity, asset.",
    "- amount is the cash amount as a decimal string (can be negative).",
    "- exchangeRate is the FX rate to THB if derivable, else null.",
    "- amountThb is the THB-converted amount if derivable, else null.",
    "- confidence is a number from 0 to 1 reflecting how confident you are.",
    "- If part of the statement is unclear, record a warning string rather than inventing data.",
    "Return only JSON matching the provided schema.",
    "\n--- STATEMENT TEXT ---\n",
    statementText,
  ].join("\n");
}

/**
 * Parse and locally validate the raw JSON text returned by Gemini into typed
 * application data. Throws GeminiError (GEMINI_INVALID_RESPONSE for malformed
 * JSON, GEMINI_SCHEMA_VALIDATION_FAILED for schema violations).
 *
 * Pure function — takes only the raw response text, never calls the API. This
 * makes it directly unit-testable without invoking the model.
 */
export function validateGeminiResponseText(rawText: string): GeminiStatementResult {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    throw new GeminiError(
      GeminiErrorCode.INVALID_RESPONSE,
      "Gemini returned an empty response"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new GeminiError(
      GeminiErrorCode.INVALID_RESPONSE,
      "Gemini returned malformed JSON"
    );
  }

  const validated = geminiStatementSchema.safeParse(parsed);
  if (!validated.success) {
    throw new GeminiError(
      GeminiErrorCode.SCHEMA_VALIDATION_FAILED,
      "Gemini response failed local schema validation"
    );
  }

  return validated.data;
}

/**
 * Run the Gemini structured extraction on extracted statement text and validate
 * the result locally with Zod. Returns a typed, validated result or throws a
 * GeminiError with a stable machine-readable code.
 *
 * This function never logs the API key or the full statement text.
 */
export async function parseStatementWithGemini(
  statementText: string
): Promise<GeminiParseOutcome> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new GeminiError(
      GeminiErrorCode.NOT_CONFIGURED,
      "Gemini integration is not configured (GEMINI_API_KEY is missing)"
    );
  }

  const model = resolveGeminiModel();
  const ai = new GoogleGenAI({ apiKey });

  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: buildPrompt(statementText),
      config: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_RESPONSE_SCHEMA as never,
        temperature: 0.2,
      },
    });
  } catch (error) {
    // Log ONLY sanitized fields (error type, optional HTTP status, low-level
    // cause code). Never log raw upstream messages/URLs, the API key, auth
    // headers, or the statement text.
    const failure = classifyGeminiRequestFailure(error);
    console.error("parseStatementWithGemini: request failed (GEMINI_REQUEST_FAILED)", {
      upstreamType: failure.type,
      upstreamStatus: failure.status ?? undefined,
      causeCode: failure.code ?? undefined,
    });
    throw new GeminiError(
      GeminiErrorCode.REQUEST_FAILED,
      "Gemini request failed",
      failure
    );
  }

  const result = validateGeminiResponseText(response.text ?? "");

  return { ok: true, result, model };
}

