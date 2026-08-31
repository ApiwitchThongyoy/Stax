// Iteration 2 W1-1/W1-2 — static placeholders & real-wiring UI tests.
//
// These tests inspect the production USER dashboard / FX-AI UI source files to
// guarantee that:
//   - no stale fake placeholder values remain (35.42, $4,120.35, "Live BOT
//     API", the hardcoded 18% software recommendation),
//   - truthful not-available states are present,
//   - the real Gemini + Tax Core Engine wiring exists in the UI.
//
// This is intentionally DOM-free (no browser / no real Gemini API call) and
// runs anywhere with fs + the checked-in files.
//
// Run:  npx tsx scripts/test-ui-placeholders.mts
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateGeminiResponseText,
  GeminiError,
  GeminiErrorCode,
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

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const dashboard = read("app/component/DashboardUser/Dashboard.tsx");
const fx = read("app/component/DashboardUser/FxAiPage.tsx");
const uploader = read("app/component/DashboardUser/PdfStatementUploader.tsx");
const uploadRoute = read("app/routes/api/statements/upload.ts");

// ---------------------------------------------------------------------------
// 1. No stale fake placeholder values anywhere in the user UI.
// ---------------------------------------------------------------------------
const forbidden = [
  "35.42",
  "4,120.35",
  "$4,120.35",
  "Live BOT API",
  "18%",
  "ซอฟต์แวร์",
  "อัปเดตล่าสุด 2 นาทีที่แล้ว",
];

for (const frag of forbidden) {
  ok(
    !dashboard.includes(frag),
    `Dashboard.tsx does not contain placeholder '${frag}'`
  );
  ok(!fx.includes(frag), `FxAiPage.tsx does not contain placeholder '${frag}'`);
  ok(
    !uploader.includes(frag),
    `PdfStatementUploader.tsx does not contain placeholder '${frag}'`
  );
}

// ---------------------------------------------------------------------------
// 2. Truthful NOT-AVAILABLE states on the user Dashboard.
// ---------------------------------------------------------------------------
ok(
  dashboard.includes("NOT AVAILABLE"),
  "Dashboard shows a NOT AVAILABLE state"
);
ok(
  dashboard.includes("ยังไม่ได้เชื่อมต่อ BOT API"),
  "Dashboard exchange-rate card is truthful (BOT API not connected)"
);
ok(
  dashboard.includes("ยังไม่สามารถคำนวณภาษีได้"),
  "Dashboard tax card is truthful (tax not computable)"
);
ok(
  dashboard.includes("ยังไม่มีคำแนะนำจาก AI"),
  "Dashboard AI card has no fabricated recommendation"
);

// ---------------------------------------------------------------------------
// 3. Real Gemini flow wiring in the UI.
// ---------------------------------------------------------------------------
ok(
  uploader.includes("onGeminiResult") && uploader.includes("res.ai"),
  "PdfStatementUploader surfaces the real Gemini upload result via onGeminiResult"
);
ok(
  fx.includes("วิเคราะห์ Statement สำเร็จ"),
  "FxAiPage shows a successful Gemini analysis state"
);
ok(
  fx.includes("ยังไม่ได้ตั้งค่า Gemini API"),
  "FxAiPage shows the Gemini-not-configured state"
);
ok(
  fx.includes("transactionDate") && fx.includes("description"),
  "FxAiPage renders Gemini transaction fields (date + description)"
);

// ---------------------------------------------------------------------------
// 3b. Regression: a Statement that already produces deterministic rows must
//     still be eligible for Gemini analysis when Gemini is configured.
//     Static guard on the upload route: runGeminiAnalysis is invoked BEFORE the
//     deterministic row-count/duplicate gate, and every response path carries ai.
// ---------------------------------------------------------------------------
const geminiCallIdx = uploadRoute.indexOf("await runGeminiAnalysis(");
const rowGateIdx = uploadRoute.indexOf("built.rows.length === 0");
ok(
  geminiCallIdx !== -1 && rowGateIdx !== -1 && geminiCallIdx < rowGateIdx,
  "upload route runs Gemini analysis even when deterministic rows exist (call precedes row gate)"
);
const aiInResponseCount = uploadRoute.split("ai: aiResult").length - 1;
ok(
  aiInResponseCount >= 3,
  `upload route attaches ai: aiResult to every response path (found ${aiInResponseCount})`
);

// ---------------------------------------------------------------------------
// 3c. Session-scoped delivery of the validated Gemini result (survives
//     navigation from Dashboard uploader to the FX/AI page, no DB table).
// ---------------------------------------------------------------------------
ok(
  uploader.includes("saveLatestGeminiAnalysis") &&
    uploader.includes("stax_latest_gemini_analysis") === false,
  "PdfStatementUploader persists the validated result via session store"
);
ok(
  fx.includes("loadLatestGeminiAnalysis"),
  "FxAiPage restores the latest validated analysis on mount"
);
ok(
  fx.includes("GEMINI_REQUEST_FAILED") &&
    fx.includes("GEMINI_SCHEMA_VALIDATION_FAILED"),
  "FxAiPage surfaces distinct Gemini request/schema-failure states"
);

// ---------------------------------------------------------------------------
// 4. Real Tax Core Engine wiring in the UI (no fabricated estimate).
// ---------------------------------------------------------------------------
ok(
  fx.includes("/api/v1/capital-ledgers"),
  "FxAiPage fetches the user's real capital transactions"
);
ok(
  fx.includes("/api/v1/tax/calculate"),
  "FxAiPage calls the real /api/v1/tax/calculate endpoint"
);
ok(
  fx.includes("ยังไม่สามารถคำนวณฐานภาษีรวมได้ เนื่องจากข้อมูลต้นทุนยังไม่ครบ"),
  "FxAiPage shows the honest not-computable total state"
);
ok(
  fx.includes("ยังไม่สามารถคำนวณภาษีรายการนี้ได้"),
  "FxAiPage explains the missing cost basis per transaction"
);
ok(
  !fx.includes("$4,120.35") && !fx.includes("4,120.35"),
  "FxAiPage never shows a hardcoded tax estimate"
);

// ---------------------------------------------------------------------------
// 5. Malformed Gemini output must be rejected (server-side schema guard).
//    No real Gemini API is called here.
// ---------------------------------------------------------------------------
ok(
  (() => {
    try {
      validateGeminiResponseText("not json {");
      return false;
    } catch (e) {
      return (
        e instanceof GeminiError &&
        e.code === GeminiErrorCode.INVALID_RESPONSE
      );
    }
  })(),
  "malformed Gemini output is rejected by the server validator"
);
ok(
  (() => {
    try {
      validateGeminiResponseText(
        JSON.stringify({
          statement: {
            transactions: [
              {
                transactionDate: "2026-02-30",
                description: "x",
                transactionType: "income",
                currency: "USD",
                amount: "1.00",
              },
            ],
          },
        })
      );
      return false;
    } catch (e) {
      return (
        e instanceof GeminiError &&
        e.code === GeminiErrorCode.SCHEMA_VALIDATION_FAILED
      );
    }
  })(),
  "schema-invalid Gemini output is rejected by the server validator"
);

console.log("\n================ SUMMARY ================");
console.log(`PASS: ${passed}   FAIL: ${failed}`);
if (failed > 0) {
  console.log("Failures:\n - " + failures.join("\n - "));
  process.exitCode = 1;
} else {
  console.log("All UI placeholder/wiring checks passed.");
}
