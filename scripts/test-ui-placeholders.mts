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
const dbSchema = read("app/db/schema.ts");
const statementHash = read("app/lib/statement-hash.ts");
const migration = read("drizzle/0006_add_document_content_hash.sql");
const exchangeRatesRoute = read("app/routes/api/exchange-rates.ts");
const envExample = read(".env.example");

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
// 2. Truthful NOT-AVAILABLE / summary states on the user Dashboard.
// ---------------------------------------------------------------------------
ok(
  dashboard.includes("NOT AVAILABLE"),
  "Dashboard keeps a NOT AVAILABLE state for a genuinely non-computable tax base"
);
ok(
  dashboard.includes("ยังไม่มีข้อมูลอัตราแลกเปลี่ยน"),
  "Dashboard exchange-rate card has a truthful no-rate state"
);
ok(
  !dashboard.includes("BOT API"),
  "Dashboard never blames BOT API for a missing exchange rate"
);
ok(
  dashboard.includes("จาก Historical FX Provider") &&
    dashboard.includes("แหล่งที่มา: Historical FX Provider"),
  "Dashboard FX card labels the external fallback as 'Historical FX Provider' (no BOT wording)"
);
ok(
  !dashboard.includes("อ้างอิงจากภายนอก"),
  "Dashboard drops the old generic external-rate label in favor of Historical FX Provider"
);
ok(
  !fx.includes("BOT"),
  "FxAiPage has zero BOT references (retired provider wording fully removed)"
);
ok(
  exchangeRatesRoute.includes("historical-fx-provider") &&
    !exchangeRatesRoute.includes("bot-exchange-rate") &&
    !exchangeRatesRoute.includes("apigw1.bot.or.th"),
  "exchange-rates route uses the keyless historical FX provider (BOT module removed)"
);
ok(
  !envExample.includes("BOT_API_KEY"),
  ".env.example no longer documents a BOT_API_KEY requirement"
);
ok(
  dashboard.includes("แหล่งที่มา: Statement"),
  "Dashboard exchange-rate card cites the Statement as the FX source when available"
);
ok(
  dashboard.includes("ฐานภาษีที่คำนวณได้"),
  "Dashboard tax card shows the computable tax base (not 'tax payable')"
);
ok(
  dashboard.includes("ยังไม่มีฐานภาษีที่คำนวณได้"),
  "Dashboard tax card is truthful when nothing is computable"
);
ok(
  dashboard.includes("มีบางรายการที่ยังคำนวณไม่ได้"),
  "Dashboard P&L card warns about non-computable rows without blanking the whole card"
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
// 3b. Regression: a fresh Statement that already produces deterministic rows must
//     still be eligible for Gemini analysis when Gemini is configured.
//     Static guard on the upload route's FRESH-import path: runGeminiAnalysis is
//     invoked BEFORE the deterministic row-count/duplicate gate, and every
//     response path carries ai. The rebuild path (a deleted document's rows are
//     restored) is structured separately and intentionally does NOT re-run the
//     row-gate ordering here.
// ---------------------------------------------------------------------------
const geminiCallIdx = uploadRoute.indexOf("await runGeminiAnalysis(");
const rowBatch = uploadRoute.match(/built\.rows\.length === 0/g) ?? [];
const rowGateIdx = rowBatch.length
  ? uploadRoute.indexOf("built.rows.length === 0", geminiCallIdx)
  : -1;
ok(
  geminiCallIdx !== -1 &&
    rowBatch.length >= 1 &&
    rowGateIdx !== -1 &&
    geminiCallIdx < rowGateIdx,
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

// ---------------------------------------------------------------------------
// 6. Duplicate Statement import — content-hash guard wiring (W3).
// ---------------------------------------------------------------------------
ok(
  dbSchema.includes("contentHash") && dbSchema.includes("content_hash"),
  "documents schema declares a content-hash column"
);
ok(
  dbSchema.includes("documents_user_content_hash_key") &&
    dbSchema.includes("IS NOT NULL"),
  "documents schema declares a partial unique (user, content hash) index"
);
ok(
  migration.includes('ADD COLUMN "content_hash" text') &&
    migration.includes("CREATE UNIQUE INDEX") &&
    migration.includes("WHERE") &&
    migration.includes("content_hash") ,
  "migration adds the nullable content_hash column + partial unique index (safe for existing rows)"
);
ok(
  statementHash.includes("computeContentHash") &&
    statementHash.includes("STATEMENT_ALREADY_IMPORTED") &&
    statementHash.includes("buildDuplicatePayload"),
  "pure hash + duplicate-payload helpers exist"
);
ok(
  uploadRoute.includes("computeContentHash") &&
    uploadRoute.includes("findExistingDocumentByHash") &&
    uploadRoute.includes("buildDuplicatePayload"),
  "upload route computes hash, checks user-scoped duplicates, returns duplicate payload"
);
ok(
  uploadRoute.includes("buildDuplicatePayload") &&
    statementHash.includes("STATEMENT_ALREADY_IMPORTED") &&
    statementHash.includes("duplicate: true") &&
    statementHash.includes('message: "Statement นี้เคยถูกนำเข้าแล้ว"'),
  "upload route returns STATEMENT_ALREADY_IMPORTED duplicate response"
);
ok(
  uploader.includes("STATEMENT_ALREADY_IMPORTED") &&
    uploader.includes("Statement นี้เคยถูกนำเข้าแล้ว จึงไม่มีการเพิ่มรายการซ้ำ"),
  "uploader surfaces a clear Thai duplicate message (not a generic failure)"
);
ok(
  !uploader.includes("Statement นี้เคยถูกนำเข้าแล้ว") === false,
  "uploader does not regress the duplicate message"
);

console.log("\n================ SUMMARY ================");
console.log(`PASS: ${passed}   FAIL: ${failed}`);
if (failed > 0) {
  console.log("Failures:\n - " + failures.join("\n - "));
  process.exitCode = 1;
} else {
  console.log("All UI placeholder/wiring checks passed.");
}
