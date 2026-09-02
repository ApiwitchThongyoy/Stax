// W2-11a — Gemini neutral-insight module unit tests (DB-free).
//
// These tests exercise the analysis-flavored Gemini output path added alongside
// the statement parser: the strict Zod insight schema, the JSON text validator,
// and the guarantee that the model can only emit qualitative TEXT (never money
// values). They NEVER call the live Gemini API.
//
// Run:  npx tsx scripts/test-gemini-insight.mts
import { strict as assert } from "node:assert";
import {
  geminiInsightSchema,
  GEMINI_INSIGHT_RESPONSE_SCHEMA,
  validateGeminiInsightText,
} from "../app/lib/gemini-analysis";

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

function validInsightText(): string {
  return JSON.stringify({
    summary: "The statement shows recurring monthly deposits in USD.",
    patterns: ["Monthly recurring deposits", "Mixed USD/THB activity"],
    dataQualityNotes: ["No acquisition cost basis captured", "Sparse rows in January"],
    taxReadinessNotes: [
      "Tax cannot be computed because the ledger stores raw cash in/out without cost basis.",
    ],
  });
}

async function main() {
  console.log("\n=== W2-11a: GEMINI NEUTRAL INSIGHT (no live API) ===\n");

  // 1. A fully valid insight passes strict validation.
  {
    const insight = validateGeminiInsightText(validInsightText());
    ok(insight.summary.length > 0, "valid summary accepted");
    ok(insight.patterns.length === 2, "valid patterns accepted (2)");
    ok(insight.taxReadinessNotes.length === 1, "valid taxReadinessNotes accepted (1)");
  }

  // 2. Strict schema: extra/unknown fields are rejected.
  {
    const strict = geminiInsightSchema.safeParse({
      summary: "neutral",
      patterns: [],
      dataQualityNotes: [],
      taxReadinessNotes: [],
      taxAmount: "5000.00", // model must NEVER emit a money value
    });
    ok(strict.success === false, "extra field with a money value is rejected (strict)");

    let extraErr = "";
    try {
      validateGeminiInsightText(
        JSON.stringify({
          summary: "neutral",
          patterns: [],
          dataQualityNotes: [],
          taxReadinessNotes: [],
          taxLiability: 1234,
        })
      );
    } catch (e) {
      extraErr = e instanceof Error ? e.message : String(e);
    }
    ok(extraErr === "gemini_schema", "validator rejects a money-shaped extra field");
  }

  // 3. Missing required fields are rejected.
  {
    const missing = geminiInsightSchema.safeParse({
      patterns: [],
      dataQualityNotes: [],
      taxReadinessNotes: [],
    });
    ok(missing.success === false, "insight without summary is rejected");
  }

  // 4. Money-shaped values inside allowed TEXT fields are rejected by type.
  {
    const numericMoney = geminiInsightSchema.safeParse({
      summary: 5000, // must be a string, never a number
      patterns: [],
      dataQualityNotes: [],
      taxReadinessNotes: [],
    });
    ok(numericMoney.success === false, "numeric summary (money value) rejected");
  }

  // 5. Empty / malformed JSON handling.
  {
    let emptyErr = "";
    try {
      validateGeminiInsightText("  ");
    } catch (e) {
      emptyErr = e instanceof Error ? e.message : String(e);
    }
    ok(emptyErr === "gemini_empty", "empty text -> gemini_empty");

    let badJson = "";
    try {
      validateGeminiInsightText("{ not json");
    } catch (e) {
      badJson = e instanceof Error ? e.message : String(e);
    }
    ok(badJson === "gemini_bad_json", "malformed JSON -> gemini_bad_json");

    let schemaErr = "";
    try {
      validateGeminiInsightText(JSON.stringify({ nope: true }));
    } catch (e) {
      schemaErr = e instanceof Error ? e.message : String(e);
    }
    ok(schemaErr === "gemini_schema", "JSON failing the schema -> gemini_schema");
  }

  // 6. The response schema advertised to the API contains no money/number fields.
  {
    const props = Object.keys(
      (GEMINI_INSIGHT_RESPONSE_SCHEMA.properties ?? {}) as Record<string, unknown>
    ).sort();
    const required = (
      (GEMINI_INSIGHT_RESPONSE_SCHEMA.required ?? []) as string[]
    ).sort();
    ok(
      props.length === 4 &&
        props.includes("summary") &&
        props.includes("patterns") &&
        props.includes("dataQualityNotes") &&
        props.includes("taxReadinessNotes"),
      "response schema exposes exactly the 4 qualitative text fields"
    );
    ok(
      required.length === 4,
      "response schema requires all 4 fields"
    );
    const schemaText = JSON.stringify(GEMINI_INSIGHT_RESPONSE_SCHEMA).toLowerCase();
    ok(
      !/"(type)":\s*"(number|integer)"|"amount|"liability|"profit|"gain|"loss\b/.test(schemaText),
      "response schema contains no numeric-typed or money-named fields"
    );
    ok(
      !schemaText.includes("taxLiability") && !schemaText.includes("taxAmount"),
      "response schema contains no tax figure fields"
    );
  }

  assert.ok(true, "test harness sanity");

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