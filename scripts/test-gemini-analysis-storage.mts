// W1-1 regression — Gemini analysis session-store unit tests.
//
// Verifies that the latest VALIDATED Gemini analysis is stored/restored across
// navigation using only sessionStorage (no DB table), that invalid/error
// results are never presented as success, and that no secret material is ever
// persisted. No real Gemini API call is made.
//
// Run:  npx tsx scripts/test-gemini-analysis-storage.mts
import {
  GEMINI_LATEST_ANALYSIS_KEY,
  saveLatestGeminiAnalysis,
  loadLatestGeminiAnalysis,
  type KeyValueStorage,
} from "../app/lib/gemini-analysis-storage";
import type { AiResult, AiTransaction } from "../app/lib/ai-result";

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

function fakeStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

function geminiResult(
  description: string,
  transactions: AiTransaction[] = []
): Extract<AiResult, { source: "gemini" }> {
  return {
    source: "gemini",
    code: null,
    result: {
      statement: {
        transactions,
        warnings: transactions.length ? ["note"] : [],
      },
    },
  };
}

function main() {
  console.log("\n=== W1-1: GEMINI ANALYSIS SESSION STORE ===\n");

  const storage = fakeStorage();

  // 1. A validated result is stored and restored.
  const ai = geminiResult("dividend", [
    {
      transactionDate: "2026-01-05",
      description: "dividend",
      transactionType: "income",
      currency: "USD",
      amount: "12.50",
      exchangeRate: "34.10",
      amountThb: "426.25",
      confidence: 0.9,
    },
  ]);
  saveLatestGeminiAnalysis(ai, storage);
  const raw = storage.getItem(GEMINI_LATEST_ANALYSIS_KEY) ?? "";
  ok(raw.includes(`"source":"gemini"`), "validated result stored under the session key");
  const restored = loadLatestGeminiAnalysis(storage);
  ok(
    restored !== null &&
      restored.result.statement.transactions.length === 1 &&
      restored.result.statement.transactions[0].description === "dividend",
    "stored validated analysis is restored with its transactions"
  );
  ok(
    raw.includes("exchangeRate") && raw.includes("amountThb") && raw.includes("confidence"),
    "stored result keeps exchangeRate/amountThb/confidence fields"
  );
  ok(
    raw.includes("warnings"),
    "stored result keeps warnings"
  );

  // 2. A new successful analysis replaces the previous one.
  const ai2 = geminiResult("interest", [
    {
      transactionDate: "2026-02-01",
      description: "interest",
      transactionType: "income",
      currency: "USD",
      amount: "3.00",
    },
  ]);
  saveLatestGeminiAnalysis(ai2, storage);
  const restored2 = loadLatestGeminiAnalysis(storage);
  ok(
    restored2 !== null && restored2.result.statement.transactions[0].description === "interest",
    "new successful analysis replaces the previous result"
  );

  // 3. An error / unavailable result is NEVER stored and clears a previous one.
  saveLatestGeminiAnalysis({ source: "unavailable", code: "GEMINI_NOT_CONFIGURED", errors: ["x"] }, storage);
  ok(
    storage.getItem(GEMINI_LATEST_ANALYSIS_KEY) === null,
    "unavailable result is not stored (previous cleared)"
  );
  ok(loadLatestGeminiAnalysis(storage) === null, "unavailable result is not restored as success");

  // 4. A schema-failure result also clears the store.
  saveLatestGeminiAnalysis(ai2, storage);
  saveLatestGeminiAnalysis({ source: "unavailable", code: "GEMINI_SCHEMA_VALIDATION_FAILED", errors: ["y"] }, storage);
  ok(
    storage.getItem(GEMINI_LATEST_ANALYSIS_KEY) === null &&
      loadLatestGeminiAnalysis(storage) === null,
    "schema-validation-failed result is not presented as success"
  );

  // 5. Malformed / invalid stored payloads are ignored.
  storage.setItem(GEMINI_LATEST_ANALYSIS_KEY, "not json");
  ok(loadLatestGeminiAnalysis(storage) === null, "malformed JSON in store is ignored");
  storage.setItem(GEMINI_LATEST_ANALYSIS_KEY, JSON.stringify({ source: "gemini", code: null, result: {} }));
  ok(loadLatestGeminiAnalysis(storage) === null, "payload without statement.transactions is ignored");
  storage.setItem(GEMINI_LATEST_ANALYSIS_KEY, JSON.stringify({ source: "unavailable", code: "x", errors: [] }));
  ok(loadLatestGeminiAnalysis(storage) === null, "stored unavailable payload is not restored as success");

  // 6. No secret material is ever persisted.
  const leaked = JSON.stringify(loadLatestGeminiAnalysis(fakeStorage()));
  ok(
    /api[-_]?key|secret|password|bearer/i.test(leaked) === false,
    "restored payload contains no secret fields"
  );
  saveLatestGeminiAnalysis(ai, storage);
  const storedText = storage.getItem(GEMINI_LATEST_ANALYSIS_KEY) ?? "";
  ok(
    /api[-_]?key|secret|password|bearer/i.test(storedText) === false,
    "stored payload contains no secret fields"
  );

  // 7. Null storage (e.g. SSR) never throws and yields null.
  ok(loadLatestGeminiAnalysis(null) === null, "null storage returns null");
  saveLatestGeminiAnalysis(ai, null);
  ok(true, "saveLatestGeminiAnalysis with null storage does not throw");

  console.log("\n================ SUMMARY ================");
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failed > 0) {
    console.log("Failures:\n - " + failures.join("\n - "));
    process.exitCode = 1;
  } else {
    console.log("All Gemini analysis session-store checks passed.");
  }
}

main();