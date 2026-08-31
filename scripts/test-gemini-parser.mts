// W1-1 — Gemini structured parser unit tests.
//
// These tests NEVER call the real Gemini API. They exercise the local Zod
// schema validation, JSON parsing behavior, and the missing-key error path
// only, using the exported validation surface from gemini-statement-parser.
//
// Run:  npx tsx scripts/test-gemini-parser.mts
import { strict as assert } from "node:assert";
import {
  geminiStatementSchema,
  parseStatementWithGemini,
  validateGeminiResponseText,
  isGeminiConfigured,
  GeminiError,
  GeminiErrorCode,
  DEFAULT_GEMINI_MODEL,
} from "../app/lib/gemini-statement-parser";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function validPayload() {
  return {
    statement: {
      transactions: [
        {
          transactionDate: "2026-01-05",
          description: "Dividend income",
          transactionType: "income",
          currency: "USD",
          amount: "1000.00",
          exchangeRate: "35.42",
          amountThb: "35420.00",
          confidence: 0.95,
        },
      ],
      warnings: [],
    },
  };
}

function safeParse(input: unknown) {
  return geminiStatementSchema.safeParse(input);
}

async function main() {
  console.log("\n=== W1-1: GEMINI STRUCTURED PARSER (no live API) ===\n");

  // 1. valid structured result
  ok(safeParse(validPayload()).success, "valid Gemini-like structured result passes");

  // 2. currency normalization (uppercase) + extracts typed data
  const lower = validPayload();
  lower.statement.transactions[0].currency = "usd";
  const res = safeParse(lower);
  ok(res.success && res.data.statement.transactions[0].currency === "USD", "currency normalized to uppercase");

  // 4. missing required fields
  const missingDate = validPayload();
  (missingDate.statement.transactions[0] as Record<string, unknown>).transactionDate = undefined;
  ok(!safeParse(missingDate).success, "missing required transactionDate rejected");
  const missingAmount = validPayload();
  (missingAmount.statement.transactions[0] as Record<string, unknown>).amount = undefined;
  ok(!safeParse(missingAmount).success, "missing required amount rejected");

  // 5. invalid enum
  const badEnum = validPayload();
  badEnum.statement.transactions[0].transactionType = "savings";
  ok(!safeParse(badEnum).success, "invalid transactionType enum rejected");

  // 6. invalid decimal string
  const badAmt = validPayload();
  badAmt.statement.transactions[0].amount = "NaN";
  ok(!safeParse(badAmt).success, "NaN amount rejected");
  const badInf = validPayload();
  badInf.statement.transactions[0].amount = "Infinity";
  ok(!safeParse(badInf).success, "Infinity amount rejected");
  const badMalformed = validPayload();
  badMalformed.statement.transactions[0].amount = "12..34";
  ok(!safeParse(badMalformed).success, "malformed amount rejected");
  const goodDecimal = validPayload();
  goodDecimal.statement.transactions[0].amount = "-0.00125";
  const gd = safeParse(goodDecimal);
  ok(gd.success && gd.data.statement.transactions[0].amount === "-0.00125", "valid decimal string accepted");

  // 7. invalid date
  const badDate = validPayload();
  badDate.statement.transactions[0].transactionDate = "2026-02-30";
  ok(!safeParse(badDate).success, "invalid calendar date (2026-02-30) rejected");

  // 8. extra unexpected fields rejected (.strict)
  const extra = validPayload();
  (extra.statement.transactions[0] as Record<string, unknown>).bonus = "x";
  ok(!safeParse(extra).success, "extra unexpected transaction field rejected (.strict)");
  const extraTop = validPayload();
  (extraTop as Record<string, unknown>).bonus = "x";
  ok(!safeParse(extraTop).success, "extra top-level field rejected (.strict)");

  // 9. empty transactions allowed but non-array rejected
  const empty = { statement: { transactions: [], warnings: [] } };
  ok(safeParse(empty).success, "empty transactions array accepted");

  // 10. non-object JSON-shaped input rejected
  ok(!safeParse("not an object").success, "non-object payload rejected");

  // 10b. malformed JSON text through the validate function (no API call)
  for (const raw of ["", "   ", "not json {", "{ uh oh", "[1,2", "{\"x\":}"] as const) {
    let code: string | null = null;
    try {
      validateGeminiResponseText(raw);
    } catch (e) {
      if (e instanceof GeminiError) code = e.code;
    }
    ok(code === GeminiErrorCode.INVALID_RESPONSE, `malformed JSON ${JSON.stringify(raw)} -> INVALID_RESPONSE`);
  }

  // 10c. valid JSON text that fails schema -> SCHEMA_VALIDATION_FAILED
  const badShape = JSON.stringify({ statement: { transactions: [{ transactionDate: "bad" }] } });
  let shapeCode: string | null = null;
  try {
    validateGeminiResponseText(badShape);
  } catch (e) {
    if (e instanceof GeminiError) shapeCode = e.code;
  }
  ok(shapeCode === GeminiErrorCode.SCHEMA_VALIDATION_FAILED, "schema-invalid JSON text -> SCHEMA_VALIDATION_FAILED");

  // 10d. valid JSON text passes validate function
  const goodJson = JSON.stringify(validPayload());
  let goodResult: unknown = null;
  try {
    goodResult = validateGeminiResponseText(goodJson);
  } catch {
    goodResult = null;
  }
  ok(
    !!goodResult &&
      (goodResult as { statement: { transactions: unknown[] } }).statement.transactions.length === 1,
    "valid JSON text passes validateGeminiResponseText"
  );

  // 11. model resolution: default used when GEMINI_MODEL absent
  const prevModel: string | undefined = process.env.GEMINI_MODEL;
  process.env.GEMINI_MODEL = "";
  const { resolveGeminiModel } = await import("../app/lib/gemini-statement-parser");
  ok(resolveGeminiModel() === DEFAULT_GEMINI_MODEL, "default model used when GEMINI_MODEL absent");
  process.env.GEMINI_MODEL = "custom-flash";
  ok(resolveGeminiModel() === "custom-flash", "GEMINI_MODEL env overrides default");
  process.env.GEMINI_MODEL = prevModel ?? "";

  // 12. missing API key -> NOT_CONFIGURED thrown by the real function
  const prevKey: string | undefined = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "";
  ok(isGeminiConfigured() === false, "isGeminiConfigured false when key absent");
  let errCode: string | null = null;
  try {
    await parseStatementWithGemini("statement text");
  } catch (e) {
    if (e instanceof GeminiError) errCode = e.code;
  }
  ok(errCode === GeminiErrorCode.NOT_CONFIGURED, "missing key -> GEMINI_NOT_CONFIGURED error");
  process.env.GEMINI_API_KEY = prevKey ?? "";

  // 13. configured flag true when key present
  process.env.GEMINI_API_KEY = "test-key";
  ok(isGeminiConfigured() === true, "isGeminiConfigured true when key present");
  // restore
  process.env.GEMINI_API_KEY = prevKey ?? "";

  // 14. REGRESSION — Gemini sometimes returns monetary values as JSON numbers
  // (and confidence as a numeric string) despite the STRING contract. These are
  // legitimate representations that must be normalized, not rejected.
  const numericPayload = {
    statement: {
      transactions: [
        {
          transactionDate: "2026-01-05",
          description: "Dividend income",
          transactionType: "income",
          currency: "USD",
          amount: 1000.0,
          exchangeRate: 35.42,
          amountThb: 35420.0,
          confidence: "0.95",
        },
      ],
      warnings: [],
    },
  };
  const numericRes = safeParse(numericPayload);
  ok(numericRes.success, "monetary JSON numbers + confidence string are accepted (+ normalization)");
  const numTx = numericRes.success
    ? numericRes.data.statement.transactions[0]
    : null;
  ok(
    numTx !== null &&
      numTx.amount === "1000" &&
      numTx.exchangeRate === "35.42" &&
      numTx.amountThb === "35420",
    "JSON number monetary values normalize to decimal strings"
  );
  ok(
    numTx !== null && numTx.confidence === 0.95,
    "numeric-string confidence normalizes to a JSON number"
  );

  // 14b. Optional/nullable monetary fields remain optional even as numbers.
  const sparseNumeric = {
    statement: {
      transactions: [
        {
          transactionDate: "2026-02-01",
          description: "Fee",
          transactionType: "expense",
          currency: "THB",
          amount: 50.5,
        },
      ],
      warnings: [],
    },
  };
  const sparseRes = safeParse(sparseNumeric);
  ok(
    sparseRes.success &&
      sparseRes.data.statement.transactions[0].exchangeRate === undefined &&
      sparseRes.data.statement.transactions[0].amountThb === undefined,
    "omitted exchangeRate/amountThb remain optional when amount is a number"
  );

  // 14c. Not a weakening: an invalid non-decimal number is still rejected.
  const badNumeric = {
    statement: {
      transactions: [
        {
          transactionDate: "2026-01-05",
          description: "Bad",
          transactionType: "income",
          currency: "USD",
          amount: 1e21,
        },
      ],
      warnings: [],
    },
  };
  ok(
    safeParse(badNumeric).success === false,
    "non-decimal numeric amount is still rejected (no validation weakening)"
  );

  // 14d. Full validation path accepts the numeric JSON representation too.
  const numericJson = JSON.stringify(numericPayload);
  let numericResult: unknown = null;
  try {
    numericResult = validateGeminiResponseText(numericJson);
  } catch {
    numericResult = null;
  }
  ok(
    !!numericResult &&
      (numericResult as { statement: { transactions: unknown[] } }).statement
        .transactions.length === 1,
    "validateGeminiResponseText accepts the numeric JSON representation"
  );

  console.log(`\n================ SUMMARY ================`);
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e);
  process.exit(1);
});
