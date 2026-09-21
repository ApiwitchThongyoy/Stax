// Iteration 2 W1-1/W1-2 — static placeholders & real-wiring UI tests.
//
// These tests inspect the production USER dashboard UI source files to
// guarantee that:
//   - no stale fake placeholder values remain (35.42, $4,120.35, "Live BOT
//     API", the hardcoded 18% software recommendation),
//   - truthful not-available states are present,
//   - the real statement upload / Gemini flow wiring exists in the UI.
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
import { isReferenceOnlySkip } from "../app/lib/general-ledger";

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
const uploader = read("app/component/DashboardUser/PdfStatementUploader.tsx");
const geminiAnalysisStorage = read("app/lib/gemini-analysis-storage.ts");
const geminiParser = read("app/lib/gemini-statement-parser.ts");
const uploadRoute = read("app/routes/api/statements/upload.ts");
const dbSchema = read("app/db/schema.ts");
const dashboardPage = read("app/component/DashboardUser/DashboardHomePage.tsx");
const cashFlowPage = read("app/component/DashboardUser/CashFlowPage.tsx");
const statementHash = read("app/lib/statement-hash.ts");
const migration = read("drizzle/0006_add_document_content_hash.sql");
const exchangeRatesRoute = read("app/routes/api/exchange-rates.ts");
const envExample = read(".env.example");
const routesFile = read("app/routes.ts");
const stockPricesProvider = read("app/lib/stock-price-provider.ts");
const serverApi = read("app/lib/server-api.ts");
const vercelFile = read("vercel.json");
const incomeStatementTab = read("app/component/Ledger/IncomeStatementTab.tsx");
const accountCategoryView = read(
  "app/component/LedgerRedesign/AccountCategoryView.tsx"
);
const ledgerService = read("app/lib/ledger-service.ts");
const generalLedger = read("app/lib/general-ledger.ts");
const archivePage = read("app/component/DashboardUser/StatementArchivePage.tsx");
const docTransactionsRoute = read(
  "app/routes/api/documents.$id.transactions.ts"
);
const documentsRoute = read("app/routes/api/documents.ts");
const documentStorage = read("app/lib/Documentstorage.ts");
const portfolioRoute = read("app/routes/api/portfolio.$symbol.ts");
const stockDetailPage = read(
  "app/component/DashboardUser/StockDetailPage.tsx"
);
const journalPage = read("app/component/Journal/JournalPage.tsx");
const journalTab = read("app/component/Ledger/JournalTab.tsx");
const trialBalanceTab = read("app/component/Ledger/TrialBalanceTab.tsx");
const balanceSheetTab = read("app/component/Ledger/BalanceSheetTab.tsx");
const balanceSheetShared = read("app/component/Ledger/shared.tsx");
const monthlyClosingTab = read("app/component/Ledger/MonthlyClosingTab.tsx");
const monthlyClosingRoute = read(
  "app/routes/api/reports/monthly-closing.ts"
);
const trialBalanceRoute = read("app/routes/api/reports/trial-balance.ts");
const incomeStatementRoute = read("app/routes/api/reports/income-statement.ts");
const balanceSheetRoute = read("app/routes/api/reports/balance-sheet.ts");
const generalLedgerPage = read("app/component/Ledger/GeneralLedgerPage.tsx");
const corporateActionEngine = read("app/lib/corporate-action.ts");
const corporateActionService = read("app/lib/corporate-action-service.ts");
const corporateActionRoute = read("app/routes/api/corporate-actions.ts");
const accountLedgerDetail = read("app/component/Ledger/AccountLedgerDetail.tsx");
const journalEntryModal = read("app/component/Ledger/JournalEntryModal.tsx");
const exchangeMigration = read("drizzle/0021_add_exchange_from_fields.sql");
const statementPipeline = read("app/lib/statement-pipeline.ts");
const tradingJournalRoute = read("app/routes/api/trading-journal.ts");
const tradingJournalNoteRoute = read(
  "app/routes/api/trading-journal.$transactionId.note.ts"
);
const tradingJournalEngine = read("app/lib/trading-journal-engine.ts");
const tradingJournalMigration = read("drizzle/0022_add_journal_entry_note.sql");
const tradingJournalPage = read(
  "app/component/DashboardUser/TradingJournalPage.tsx"
);
const postingEngine = read("app/lib/posting-engine.ts");
const fxReconcileScript = read("scripts/reconcile-fx-postings.mts");
const roundingReconcileScript = read("scripts/reconcile-rounding-postings.mts");
const equityReconcileScript = read("scripts/reconcile-thb-equity-postings.mts");

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
  ok(
    !uploader.includes(frag),
    `PdfStatementUploader.tsx does not contain placeholder '${frag}'`
  );
}

// ---------------------------------------------------------------------------
// 2. Truthful states on the new ledger-focused user screens (overview + upload).
//    The legacy dashboard summary cards (P&L / FX / tax / AI) were removed from
//    Dashboard.tsx entirely — no fabricated numbers can regress there anymore.
// ---------------------------------------------------------------------------
const overview = read("app/component/LedgerRedesign/OverviewTab.tsx");
const uploadPage = read("app/component/DashboardUser/StatementUploadPage.tsx");

ok(
  !dashboard.includes("NOT AVAILABLE") &&
    !dashboard.includes("ฐานภาษีที่คำนวณได้") &&
    !dashboard.includes("ยังไม่มีคำแนะนำจาก AI"),
  "Dashboard screen no longer renders the legacy P&L/FX/tax/AI summary cards (ledger-focused UI)"
);
ok(
  overview.includes("ยังไม่มีข้อมูลงบดุล"),
  "Overview tab has a truthful empty state when there is no balance-sheet data"
);
ok(
  overview.includes("ยังไม่มีการถือครองหุ้น"),
  "Overview tab has a truthful empty state when there are no holdings"
);
ok(
  overview.includes("fetchLedgerSummary") && overview.includes("fetchCostBasis"),
  "Overview tab renders only server-computed numbers (ledger/summary + cost-basis)"
);
ok(
  overview.includes("ต้นทุนรวม") &&
    overview.includes("holdingTotalCost(h)") &&
    overview.includes("holdingCurrencyCode(h.symbol)"),
  "Overview holdings card shows total cost + per-symbol currency, computed only from server fields"
);
ok(
  !overview.includes("pnlAmount *") && !uploadPage.includes("pnlAmount *"),
  "Overview/Upload no longer re-derive P&L from rate (no double FX conversion in React)"
);
ok(
  !dashboard.includes("BOT API") &&
    !overview.includes("BOT") &&
    !uploadPage.includes("BOT"),
  "New user screens have zero BOT provider references (keyless provider wording only)"
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
  uploadPage.includes("/api/v1/statements/upload"),
  "Upload page posts directly to the server upload endpoint (atomic server contract)"
);

// ---------------------------------------------------------------------------
// 3. Real Gemini flow wiring in the UI.
// ---------------------------------------------------------------------------
ok(
  uploader.includes("onGeminiResult") && uploader.includes("res.ai"),
  "PdfStatementUploader surfaces the real Gemini upload result via onGeminiResult"
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
// 3c. Session-scoped delivery of the validated Gemini result (uploader persists
//     with no DB table; the standalone FX/AI page was removed, so no loader UI).
// ---------------------------------------------------------------------------
ok(
  uploader.includes("saveLatestGeminiAnalysis") &&
    uploader.includes("stax_latest_gemini_analysis") === false,
  "PdfStatementUploader persists the validated result via session store"
);
ok(
  geminiAnalysisStorage.includes("loadLatestGeminiAnalysis") &&
    geminiAnalysisStorage.includes("stax_latest_gemini_analysis"),
  "session storage exposes the load helper + shared key for the validated result"
);
ok(
  geminiParser.includes("GEMINI_REQUEST_FAILED") &&
    geminiParser.includes("GEMINI_SCHEMA_VALIDATION_FAILED"),
  "server validator surfaces distinct Gemini request/schema-failure codes"
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
// Upload safety: heavy full-file work (arrayBuffer/hash/extract) must only
// happen AFTER cheap validation (metadata size/ext/MIME first, then a 5-byte
// %PDF- header slice). Verify the ordering in the `action` flow. (The helper
// rebuildStatementImport also reads file.arrayBuffer(), but it is only ever
// called later — after the same validation already passed in `action`.)
const actionStart = uploadRoute.indexOf("export async function action");
const actionCode = actionStart !== -1 ? uploadRoute.slice(actionStart) : uploadRoute;
const firstValidateIdx = actionCode.indexOf("validatePdfFile(file)");
const firstMagicIdx = actionCode.indexOf("hasPdfMagicBytes(file)");
const firstArrayBufferIdx = actionCode.indexOf("file.arrayBuffer()");
ok(
  firstValidateIdx !== -1 && firstMagicIdx !== -1 && firstArrayBufferIdx !== -1,
  "upload route action calls validatePdfFile + hasPdfMagicBytes + arrayBuffer"
);
ok(
  firstValidateIdx !== -1 &&
    firstMagicIdx !== -1 &&
    firstValidateIdx < firstMagicIdx &&
    firstMagicIdx < firstArrayBufferIdx,
  "upload action validates metadata BEFORE magic bytes BEFORE the full-file read"
);
ok(
  actionCode.includes("validatePdfFile") &&
    actionCode.includes('status: 400') &&
    actionCode.includes("validation.message"),
  "upload action rejects unvalidated files with a 400 + validation message"
);
// Rebuild failure must log SANITIZED server-side info only — never the raw
// error object, its message, stack, SQL, path or secrets.
const rebuildCatchIdx = uploadRoute.indexOf('"Statement upload: rebuild failed"');
const rebuildCatchCode =
  rebuildCatchIdx !== -1 ? uploadRoute.slice(rebuildCatchIdx) : "";
ok(
  rebuildCatchIdx !== -1 &&
    uploadRoute.includes("rebuildError instanceof Error") &&
    rebuildCatchCode.includes(".name") &&
    rebuildCatchCode.includes('"UnknownError"'),
  "upload rebuild catch logs sanitized errorName only (name or UnknownError)"
);
ok(
  rebuildCatchIdx !== -1 && !rebuildCatchCode.includes(", rebuildError)") &&
    !rebuildCatchCode.includes("rebuildError.message") &&
    !rebuildCatchCode.includes("rebuildError.stack") &&
    !/\bSQL\b/.test(rebuildCatchCode),
  "upload rebuild catch never logs the raw error object, message, stack or SQL"
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
ok(
  uploader.includes("duplicateModal") &&
    uploader.includes('setDuplicateModal({ open: true, fileName: file.name })') &&
    uploader.includes("Statement ซ้ำ") &&
    uploader.includes("AlertTriangle"),
  "uploader opens a centered duplicate-notification modal with an amber warning"
);
ok(
  uploader.includes('aria-label="ปิดหน้าต่าง"') &&
    uploader.includes("OK") &&
    uploader.includes("duplicateModal.open"),
  "duplicate modal is dismissed only via X or OK (no auto-close)"
);
ok(
  uploadPage.includes("duplicateModal") &&
    uploadPage.includes("setDuplicateModal({ open: true, fileName: f.name })") &&
    uploadPage.includes("Statement ซ้ำ") &&
    uploadPage.includes("AlertTriangle"),
  "upload page opens the centered duplicate-notification modal on a duplicate result"
);
ok(
  uploadPage.includes('body.data.duplicate === true') &&
    uploadPage.includes("ไฟล์นี้ถูกนำเข้าแล้ว (สำเนาซ้ำ ระบบข้ามการทำงานซ้ำ)"),
  "upload page detects `duplicate: true` and labels it honestly (not 'นำเข้าสำเร็จ')"
);
ok(
  uploadPage.includes("window.clearTimeout(t)") &&
    uploadPage.includes("importIsDuplicate") &&
    uploadPage.includes('setPhase("idle")') &&
    uploadPage.includes("setDuplicateModal({ open: true, fileName: f.name })") &&
    uploadPage.includes("!importIsDuplicate") &&
    uploadPage.includes("setPhase(\"done\")") &&
    uploadPage.includes("if (mountedRef.current && !importIsDuplicate) {") &&
    uploadPage.includes("lastSaved > 0 && onImportSuccess"),
  "duplicate stops the loading animation, returns to idle (never 'ผลการนำเข้า'), and the done transition is guarded by !importIsDuplicate (refresh fires only on a genuine save)"
);
ok(
  !uploadPage.includes("settle(duration * 6, done)") &&
    !uploadPage.includes("advanceThrough((done)") &&
    !uploadPage.includes("setPhase(\"done\")") === false &&
    uploadPage.includes("advanceThrough()"),
  "done is never reached by the progress-animation timer chain (advanceThrough takes no done callback) — a slow server can't flash an empty success screen"
);
ok(
  uploadPage.includes("await uploadPromise") &&
    uploadPage.includes("if (mountedRef.current && !importIsDuplicate) {") &&
    uploadPage.includes("lastSaved > 0"),
  "the done transition happens ONLY after `await uploadPromise` resolves and only when saved > 0"
);
ok(
  uploadPage.includes('phase === "done" && result && result.saved > 0'),
  "the success screen never renders unless result is present AND result.saved > 0 (no zero-count 'ผลการนำเข้า')"
);
ok(
  (uploadPage.match(/result\?\.saved \?\? 0/g) ?? []).length >= 1 &&
    uploadPage.includes("result?.stats?.buyCount ?? 0"),
  "done screen renders the server response counts verbatim (e.g. saved = 42 renders 42), never fabricated totals"
);
{
  const awaitIdx = uploadPage.indexOf("await uploadPromise");
  const doneIdx = uploadPage.indexOf('setPhase("done")', awaitIdx);
  const preDone = awaitIdx !== -1 && doneIdx !== -1
    ? uploadPage.slice(awaitIdx, doneIdx)
    : "";
  ok(
    awaitIdx !== -1 && doneIdx !== -1 && preDone.includes("clearTimers();"),
    "a genuinely successful import (<10s or >10s) clears the animation timers BEFORE the done transition, so a stale timer can never flip the screen away from 'done'"
  );
}
{
  const awaitIdx = uploadPage.indexOf("await uploadPromise");
  const catchIdx = uploadPage.indexOf("catch (err)", awaitIdx);
  const errIdx = catchIdx !== -1 ? uploadPage.indexOf('setPhase("error")', catchIdx) : -1;
  const catchBlock = catchIdx !== -1 && errIdx !== -1
    ? uploadPage.slice(catchIdx, errIdx + 30)
    : "";
  ok(
    catchIdx !== -1 && errIdx !== -1 && catchBlock.includes("clearTimers();"),
    "a network/server error that lands after the animation reached 'posting' still ends in error (the await-catch clears timers before setPhase('error')), never a success screen"
  );
}
ok(
  uploadPage.includes("settle(duration * 5, () => setPhase(\"posting\"))") &&
    !uploadPage.includes("settle(duration * 6"),
  "the animation timer chain advances only storing→extracting→parsing→computing→posting and STOPS at posting — an upload taking >10s stays at phase='posting' (loading), never auto-advances to done"
);

// ---------------------------------------------------------------------------
// 7b. Statement preview-before-import (แสดงรายละเอียดก่อน + ปุ่ม OK ค่อยนำเข้าจริง)
// ---------------------------------------------------------------------------
const previewRoute = read("app/routes/api/statements/preview.ts");
const statementStorage = read("app/lib/storage/statement-storage.ts");

ok(
  routesFile.includes('route("api/v1/statements/preview", "routes/api/statements/preview.ts")'),
  "preview route is registered next to the real upload route"
);
ok(
  previewRoute.includes("/api/v1/statements/preview") &&
    previewRoute.includes("loader") &&
    previewRoute.includes("action"),
  "preview route exposes loader/action (POST read-only preview, no GET handler)"
);
ok(
  previewRoute.includes("verifyAuth") &&
    previewRoute.includes("validatePdfFile") &&
    previewRoute.includes("hasPdfMagicBytes") &&
    previewRoute.includes("computeContentHash"),
  "preview reuses the server PDF validation + content-hash duplicate detection"
);
ok(
  previewRoute.includes("extractTextFromPdfBytes") &&
    previewRoute.includes("buildStatementTransactions") &&
    previewRoute.includes("applyFxRateFallback") &&
    previewRoute.includes("loadCostBasisState") &&
    previewRoute.includes("summarizeRows"),
  "preview runs the exact deterministic parse pipeline as the real upload"
);
ok(
  !previewRoute.includes("saveStatementPdf") &&
    !previewRoute.includes("insertStatementTransactions") &&
    !previewRoute.includes("saveCostBasisState") &&
    !previewRoute.includes("insertPostings") &&
    !previewRoute.includes("runGeminiAnalysis") &&
    !previewRoute.includes("insertAuditLog"),
  "preview is strictly read-only: no storage, no inserts, no basis write, no postings, no Gemini, no audit"
);
ok(
  previewRoute.includes("hasSavedDocumentRows") &&
    previewRoute.includes("buildDuplicatePayload") &&
    previewRoute.includes("statement-storage") === true,
  "preview short-circuits to the duplicate payload when the document already has saved rows"
);
ok(
  previewRoute.includes("preview: true") &&
    previewRoute.includes("rows: fallbackRows") &&
    previewRoute.includes("duplicateDecision") &&
    previewRoute.includes("stats: summarizeRows(fallbackRows)"),
  "preview response carries the full parsed rows + stats for server-authoritative rendering"
);
ok(
  previewRoute.includes('duplicateDecision: existingDocument ? "rebuilt" : "fresh"'),
  "preview reports 'rebuilt' semantics for a document whose rows were deleted"
);
ok(
  statementStorage.includes("export async function hasPdfMagicBytes"),
  "hasPdfMagicBytes is exported so the preview route reuses the magic-bytes check"
);
ok(
  uploadPage.includes('fetch("/api/v1/statements/preview"'),
  "upload page calls the preview endpoint when a PDF is attached"
);
ok(
  uploadPage.includes('phase === "reviewing"') &&
    uploadPage.includes('phase === "review"') &&
    uploadPage.includes('"reviewing"') &&
    uploadPage.includes('"review"'),
  "upload page gains reviewing/review phases (preview before the import commit)"
);
ok(
  uploadPage.includes("ตรวจสอบเอกสารก่อนนำเข้า") &&
    uploadPage.includes("พบ {preview?.rows?.length") &&
    uploadPage.includes("จะนำเข้า"),
  "review screen shows a detail header + 'จะนำเข้า' count from the server preview"
);
ok(
  uploadPage.includes("กำไร/ขาดทุน (THB)") &&
    uploadPage.includes("r.transactionDate") &&
    uploadPage.includes("r.symbol") &&
    uploadPage.includes("r.side") &&
    uploadPage.includes("r.quantity") &&
    uploadPage.includes("r.unitPrice") &&
    uploadPage.includes("r.grossAmount") &&
    uploadPage.includes("r.fees") &&
    uploadPage.includes("r.amountForeign") &&
    uploadPage.includes("r.fxRateEffective") &&
    uploadPage.includes("r.realizedGainLossThb"),
  "review table renders every server field directly (no P&L/FX recompute in React)"
);
ok(
  uploadPage.includes("OK — นำเข้า") &&
    uploadPage.includes("handlePreviewConfirm") &&
    uploadPage.includes("void upload(file)"),
  "the OK button commits the real import (calls the original upload path)"
);
ok(
  uploadPage.includes("void previewFile(f)") &&
    uploadPage.includes('fetch("/api/v1/statements/upload"'),
  "attaching a PDF only previews first; the real upload endpoint fires only after OK"
);
ok(
  uploadPage.includes("body.data.duplicate === true") &&
    uploadPage.includes("setPhase(\"idle\")") &&
    uploadPage.includes("setDuplicateModal({ open: true, fileName: f.name })") &&
    uploadPage.includes("!body.data.rows || body.data.rows.length === 0"),
  "preview duplicate / unsupported files never reach the review screen (no commit)"
);
ok(
  uploadPage.includes("duplicateDecision === \"rebuilt\"") &&
    uploadPage.includes("ข้อมูลเก่าของ Statement นี้ถูกลบไปก่อนหน้า"),
  "rebuild preview explains the re-import semantics before the user commits with OK"
);
ok(
  uploadPage.includes("body.data.duplicate === true || body.data.duplicates === true") &&
    uploadPage.includes("body.data.saved === 0") &&
    uploadPage.includes("body.data.unsupported === true") &&
    uploadPage.includes("duplicateDecision === \"unsupported\""),
  "an upload result with saved 0 / duplicates / unsupported never renders as a normal success (guarded in the upload path)"
);
ok(
  uploadPage.includes("lastSaved > 0 && onImportSuccess") &&
    uploadPage.includes("onImportSuccess?: () => void"),
  "a genuinely successful import (saved > 0) pings the Dashboard refresh via the optional onImportSuccess prop"
);
ok(
  dashboard.includes("onImportSuccess={refreshServerData}"),
  "Dashboard wires StatementUploadPage.onImportSuccess to refreshServerData so home widgets update after an import"
);

// ---------------------------------------------------------------------------
// 8. Dashboard home page (หน้าหลัก) — server-authoritative overview widgets.
// ---------------------------------------------------------------------------
ok(
  dashboard.includes('id: "dashboard"') &&
    dashboard.includes('"หน้าหลัก"') &&
    dashboard.includes("LayoutDashboard") &&
    dashboard.includes('useState<NavId>("dashboard")'),
  "Dashboard nav gains a หน้าหลัก entry (LayoutDashboard) and is the default landing page"
);
ok(
  !dashboard.includes('useState<NavId>("gl")'),
  "บัญชีแยกประเภท is no longer the default landing page"
);
ok(
  dashboard.includes("DashboardHomePage") &&
    dashboard.includes("transactions={serverTransactions}") &&
    dashboard.includes("documents={serverDocuments}"),
  "Dashboard shell renders DashboardHomePage and passes the shared server ledger + documents"
);
ok(
  dashboardPage.includes("fetchLedgerSummary") &&
    dashboardPage.includes("fetchCostBasis") &&
    dashboardPage.includes("fetchStockQuotes"),
  "Dashboard home consumes the overview + holdings + quotes endpoints (no new backend)"
);
ok(
  dashboardPage.includes("fetchCashSummary"),
  "Dashboard home consumes the cash in/out summary endpoint"
);
ok(
  !dashboardPage.includes("grid grid-cols-1 lg:grid-cols-2 gap-6") &&
    dashboardPage.indexOf("การถือครองหุ้น") <
      dashboardPage.indexOf("สรุปเงินเข้า/ออก"),
  "Dashboard home stacks the cash summary card below the holdings card (no side-by-side grid)"
);
ok(
  dashboardPage.includes("เฉพาะเงินเข้า/ออกบัญชี") &&
    dashboardPage.includes("ยังไม่มีรายการเงินเข้า/ออก"),
  "Cash summary card is labeled as transfers-only and shows a truthful empty state"
);
ok(
  dashboardPage.includes("เงินเข้าทั้งหมด") &&
    dashboardPage.includes("เงินออกทั้งหมด") &&
    dashboardPage.includes("ยอดสุทธิ"),
  "Cash summary card exposes total cash in / total cash out / net"
);
ok(
  !dashboardPage.includes("ดูปฏิทิน") &&
    !dashboardPage.includes("onNavigate(\"calendar\")"),
  "Cash summary card no longer links to the removed calendar page"
);
ok(
  dashboardPage.includes("holdingsValue.map((x) => x.symbol)") &&
    dashboardPage.includes("Promise.allSettled"),
  "Dashboard home fetches quotes only when holdings exist and keeps widgets independent"
);
ok(
  dashboardPage.includes("สรุปงบการเงิน") &&
    dashboardPage.includes("การถือครองหุ้น") &&
    !dashboardPage.includes("เอกสาร Statement"),
  "Dashboard home renders overview + holdings widgets without the removed Statement documents section"
);
ok(
  dashboardPage.includes(">Dashboard</h1>") &&
    dashboardPage.includes("ภาพรวมพอร์ต เงินเข้า-ออก และงบการเงินของคุณ") &&
    !dashboardPage.includes("ภาพรวมบัญชีของคุณ"),
  "Dashboard banner uses the short Dashboard title + subtitle (no Statement mention)"
);
ok(
  (dashboardPage.match(/overflow-auto max-h-72/g) ?? []).length >= 6 &&
    (dashboardPage.match(/<thead className="sticky top-0 bg-white">/g) ?? [])
      .length >= 6,
  "All 6 home table sources (holdings + monthly + 3 money detail + shared exchange, rendered in 3 views) cap at ~5 rows with internal scroll + sticky header"
);
ok(
  dashboardPage.includes("เลื่อนลงเพื่อดูทั้งหมด"),
  "Home tables hint that more rows are available by scrolling"
);
ok(
  dashboardPage.includes("cashSummary?.exchanges ?? []") &&
    dashboardPage.includes("cashSummary?.exchangeTotals ?? []") &&
    dashboardPage.includes("cashSummary?.exchangeDirectionTotals ?? {"),
  "Home cash card reads the exchange strip from the same cash-summary response (no new backend)"
);
ok(
  dashboardPage.includes(
    'type CashView = "all" | "month" | "asOf" | "exchange"'
  ) &&
    dashboardPage.includes('"asOf", "exchange"') &&
    dashboardPage.includes("แลกเปลี่ยนสกุลเงิน") &&
    (dashboardPage.match(/<ExchangeSection/g) ?? []).length === 1 &&
    dashboardPage.includes(': cashView === "exchange" ? (') &&
    dashboardPage.indexOf(': cashView === "exchange" ? (') <
      dashboardPage.indexOf("cashSummary.months.length === 0"),
  "Home cash card has a 4th exchange view tab rendering the exchange section exclusively (money views carry no exchange block)"
);
ok(
  dashboardPage.includes("กลับเข้ามากว่า") &&
    dashboardPage.includes("ออกไปมากกว่า") &&
    dashboardPage.includes("ยังไม่มีรายการแลกเปลี่ยนสกุลเงินในช่วงนี้") &&
    dashboardPage.includes("ไม่ใช่รายรับ/รายจ่าย"),
  "Exchange section shows the honest net verdict, empty state, and not-income disclaimer"
);
ok(
  dashboardPage.includes("grid grid-cols-2 sm:grid-cols-4 gap-2") &&
    dashboardPage.includes("แลกเปลี่ยนสุทธิ") &&
    dashboardPage.includes("(ไม่รวมในยอดเงิน)") &&
    dashboardPage.includes("เงินเข้าทั้งหมด") &&
    dashboardPage.includes("เงินออกทั้งหมด"),
  "Cash totals row has a 4th exchange-net cell that stays out of the money in/out/net totals"
);
ok(
  dashboardPage.includes("จำนวนเงินต้นทาง") &&
    dashboardPage.includes("จำนวนเงินปลายทาง") &&
    dashboardPage.includes("fromCurrency ??") &&
    dashboardPage.includes("toCurrency ??"),
  "Home exchange section carries the full 5-column detail table (direction badges + inline units)"
);
ok(
  !dashboardPage.includes("ธุรกรรมล่าสุด") &&
    !dashboardPage.includes("ยังไม่มีรายการธุรกรรม"),
  "Dashboard home no longer renders the recent-transactions/cash-flow widget (details stay in the GL ledger)"
);
ok(
  dashboardPage.includes("ต้นทุนรวม") &&
    dashboardPage.includes("holdingTotalCost") &&
    dashboardPage.includes("holdingCurrencyCode"),
  "Dashboard home holdings card shows total cost + per-symbol currency from server fields only"
);
ok(
  dashboardPage.includes('onNavigate: (nav: DashboardNav) => void') &&
    dashboardPage.includes('{ nav: "upload"') &&
    dashboardPage.includes('{ nav: "archive"'),
  "Dashboard home wires quick links to upload / archive"
);
ok(
  dashboard.includes('"moneyflow"') === false &&
    dashboard.includes('"cashflow"') &&
    dashboard.includes('id: "cashflow"') &&
    dashboard.includes('"เงินเข้า/ออก"'),
  "Dashboard nav gains a เงินเข้า/ออก entry (cashflow) in the sidebar"
);
ok(
  dashboard.includes("CashFlowPage") &&
    dashboard.includes('activeNav === "cashflow"'),
  "Dashboard renders CashFlowPage when the cashflow nav is active"
);
ok(
  dashboard.includes('"journal"') &&
    dashboard.includes('id: "journal"') &&
    dashboard.includes('"สมุดรายวัน"'),
  "Dashboard nav gains a สมุดรายวัน entry (journal) in the sidebar"
);
ok(
  dashboard.includes("JournalPage") &&
    dashboard.includes('activeNav === "journal"'),
  "Dashboard renders JournalPage when the journal nav is active"
);
ok(
  journalPage.includes("fetchJournal(user.accessToken,") &&
    journalPage.includes("appliedFrom") &&
    journalPage.includes("appliedTo") &&
    journalPage.includes("sourceType:") &&
    journalPage.includes("postingState:"),
  "Journal page fetches entries via fetchJournal with period + sourceType/postingState filters"
);
ok(
  journalPage.includes('entry.postingState === "SKIPPED"') &&
    journalPage.includes("entry.skipReason") &&
    journalPage.includes('value="SKIPPED"') &&
    journalPage.includes('entry.skipReason === "backfilled-record-only"') &&
    journalPage.includes("ข้อมูลเก่า — นำเข้าก่อนระบบลงบัญชีอัตโนมัติ"),
  "Journal page shows SKIPPED entries with their skip reason + a status filter, and maps backfilled-record-only to a friendly Thai label"
);
ok(
  journalPage.includes("รายละเอียดรายการจาก Statement") &&
    journalPage.includes("row.label") &&
    journalPage.includes("row.value"),
  "Journal page renders the verbatim trade-detail grid from the server entry"
);
ok(
  journalPage.includes("reverseJournalEntry(user.accessToken,") &&
    journalPage.includes("isReversing"),
  "Journal page reverses entries through reverseJournalEntry"
);
ok(
  journalPage.includes("ไปที่คลัง Statement") &&
    journalPage.includes('onHintClick={onNavigateToArchive}'),
  "Journal empty-state links to the Statement archive"
);
// ---------------------------------------------------------------------------
// 12b. Journal comprehension: plain-language summary + friendly labels + search
//      + expand/collapse + grouping by date + legend. UI-only, server fields
//      rendered verbatim (no P&L/FX recompute in React).
// ---------------------------------------------------------------------------
ok(
  journalPage.includes("function tradeSummary(") &&
    journalPage.includes('d.side === "BUY" || d.side === "SELL"') &&
    journalPage.includes('"ฝากเงินเข้าบัญชี"') &&
    journalPage.includes('"ถอนเงินจากบัญชี"'),
  "Journal builds a plain-language one-line summary per entry (BUY/SELL/CASH)"
);
ok(
  journalPage.includes("function friendlyCategory(") &&
    journalPage.includes('asset: "สินทรัพย์"') &&
    journalPage.includes('equity: "ส่วนทุน"') &&
    journalPage.includes('income: "รายได้"') &&
    journalPage.includes('expense: "ค่าใช้จ่าย"'),
  "Journal translates server categories into friendly Thai labels"
);
ok(
  journalPage.includes("function matchesSearch(") &&
    journalPage.includes("l.accountName") &&
    journalPage.includes("l.accountCode") &&
    journalPage.includes("l.memo"),
  "Journal searches entries client-side across description/symbol/accounts/memo"
);
ok(
  journalPage.includes("a.entryDate.localeCompare(b.entryDate) || a.entryNo - b.entryNo") &&
    journalPage.includes(">วันที่</th>") &&
    journalPage.includes("เรียงตามวันที่ (เก่าก่อน)") &&
    !journalPage.includes("function groupEntriesByDate("),
  "Journal table is a flat date-first (ASC) list with a วันที่ column and no per-day grouping headers"
);
ok(
  journalPage.includes("function tradeSummary(entry: GeneralLedgerJournalEntry)") &&
    journalPage.includes("return entry.description;"),
  "Journal falls back to the server description when no trade detail exists"
);
ok(
  journalPage.includes('value={query}') &&
    journalPage.includes('placeholder="ค้นหารายการ — ชื่อหุ้น, บัญชี, หมายเหตุ, เลขที่"') &&
    journalPage.includes("filtered.length === 0") &&
    journalPage.includes("ไม่พบรายการที่ค้นหา"),
  "Journal search box filters live + an honest no-match state"
);
ok(
  journalPage.includes("expandedIds") &&
    journalPage.includes("toggleExpanded(entry.id)") &&
    journalPage.includes('expanded ? "ซ่อนรายละเอียด" : "ดูรายละเอียด"') &&
    !journalPage.includes("collapseAll") &&
    !journalPage.includes("expandAll") &&
    !journalPage.includes("ยุบทั้งหมด"),
  "Journal toggles each entry's detail row individually (no per-day grouping or collapse-all/expand-all)"
);
ok(
  journalPage.includes("ChevronDown") &&
    journalPage.includes("ChevronUp") &&
    journalPage.includes("expandedIds.has(entry.id)") &&
    journalPage.includes('"ซ่อนรายละเอียด"') &&
    journalPage.includes('"ดูรายละเอียด"'),
  "Journal per-entry chevron toggles that entry's detail section (default closed, one row per entry)"
);
ok(
  journalPage.includes("วิธีอ่านสมุดรายวัน") &&
    journalPage.includes("เดบิต") &&
    journalPage.includes("เครดิต") &&
    journalPage.includes("บันทึกแล้ว (รายการอ้างอิง)") &&
    journalPage.includes("บันทึกแล้ว (ยังไม่มีคู่บัญชี)") &&
    journalPage.includes("ข้อมูลเก่า (backfilled)") &&
    !journalPage.includes("เดบิต (เขียว)") &&
    !journalPage.includes("เครดิต (แดง)"),
  "Journal legend explains debit/credit without green/red color labels, and adds reference and unposted explainers"
);
ok(
  journalPage.includes("px-4 py-3 text-gray-800 font-medium text-right") &&
    !journalPage.includes("px-5 py-2.5 text-emerald-600") &&
    !journalPage.includes("px-5 py-2.5 text-red-500") &&
    journalTab.includes("px-4 py-3 text-gray-800 font-medium text-right") &&
    !journalTab.includes("px-5 py-2.5 text-emerald-600") &&
    !journalTab.includes("px-5 py-2.5 text-red-500"),
  "Debit/credit amounts are neutral gray in both journal views (no green/red)"
);
ok(
  trialBalanceTab.includes("text-gray-800 text-right whitespace-nowrap") &&
    !trialBalanceTab.includes("px-5 py-3.5 text-emerald-600") &&
    !trialBalanceTab.includes("px-5 py-3.5 text-red-500") &&
    !trialBalanceTab.includes("px-5 py-3 text-emerald-600") &&
    !trialBalanceTab.includes("px-5 py-3 text-red-500") &&
    accountLedgerDetail.includes("px-5 py-3.5 text-gray-800 font-medium") &&
    !accountLedgerDetail.includes("px-5 py-3.5 text-emerald-600") &&
    !accountLedgerDetail.includes("px-5 py-3.5 text-red-500"),
  "Trial balance + account ledger debit/credit columns are neutral gray"
);
ok(
  journalEntryModal.includes("bg-blue-50 text-blue-900") &&
    !journalEntryModal.includes("bg-emerald-50 text-emerald-700") &&
    !journalEntryModal.includes(': "bg-red-50 text-red-600"'),
  "Manual-entry side toggle uses the blue brand tone (no green/red)"
);
ok(
  trialBalanceTab.includes("ยอดรวมฐานบาท") &&
    trialBalanceTab.includes("report.totalDebitThb") &&
    trialBalanceTab.includes("report.balancedThb") &&
    incomeStatementTab.includes("report.netIncomeThb") &&
    incomeStatementTab.includes("report.totalIncomeThb") &&
    balanceSheetTab.includes("report.totalAssetsThb") &&
    balanceSheetTab.includes("report.balancedThb"),
  "Trial balance / income statement / balance sheet render THB-base totals (no cross-currency sums)"
);
ok(
  dashboardPage.includes("summary.totalsThb") &&
    overview.includes("summary.totalsThb") &&
    dashboardPage.includes("t.assetsThb") &&
    overview.includes("g.totalThb"),
  "Dashboard home + GL overview show the THB-base summary alongside per-currency cards"
);
ok(
  corporateActionEngine.includes("parentFmvPerShare") &&
    corporateActionEngine.includes("childFmvPerShare") &&
    corporateActionEngine.includes("both-or-neither") &&
    corporateActionService.includes("parentFmvPerShare") &&
    corporateActionRoute.includes("parentFmvPerShare") &&
    corporateActionRoute.includes("needsReview"),
  "Spin-off FMV pair flows engine -> service -> route, with both-or-neither validation and a derived needsReview flag"
);
ok(
  balanceSheetShared.includes("{!asOf && (") &&
    balanceSheetShared.includes("asOf = false") &&
    balanceSheetShared.includes("ถึงวันที่") &&
    balanceSheetShared.includes('value={to}') &&
    balanceSheetShared.includes('onChange={(e) => onToChange(e.target.value)}') &&
    !balanceSheetShared.includes("disabled={asOf}") &&
    !balanceSheetShared.includes("disabled"),
  "Balance-sheet PeriodFilter in as-of mode renders a single EDITABLE YYYY-MM-DD 'ถึงวันที่' input bound to 'to' (no disabled field)"
);
ok(
  balanceSheetTab.includes('asOf') &&
    balanceSheetTab.includes("onToChange={(v) => setPeriod((p) => ({ ...p, to: v }))}") &&
    balanceSheetTab.includes("onApply={() => setAppliedTo(period.to)}") &&
    balanceSheetTab.includes("setAppliedTo(d.to)") &&
    balanceSheetTab.includes("fetchBalanceSheet(user.accessToken, appliedTo)") &&
    !balanceSheetTab.includes("setAppliedTo(period.from)") &&
    !balanceSheetTab.includes("fetchBalanceSheet(user.accessToken, period.from)"),
  "BalanceSheetTab wires the editable as-of date into local period.to -> Search stores period.to in appliedTo -> fetch uses appliedTo; nothing auto-overwrites a manual selection"
);
ok(
  journalPage.includes("AccountTypeBadge") &&
    journalPage.includes("line.accountType"),
  "Journal labels every account line with its Thai account-type badge"
);
ok(
  journalPage.includes("รายละเอียดรายการจาก Statement") &&
    journalPage.includes("row.label") &&
    journalPage.includes("row.value"),
  "Journal keeps the server-field trade-detail grid"
);
ok(
  dashboardPage.includes("loadCashView") &&
    dashboardPage.includes('"all"') &&
    dashboardPage.includes('"month"') &&
    dashboardPage.includes('"asOf"'),
  "Cash card exposes the 3-view switcher (ภาพรวม/รายเดือน/ตัดยอด ณ วันที่)"
);
ok(
  dashboardPage.includes("cashMonth") &&
    dashboardPage.includes("cashAsOf") &&
    dashboardPage.includes('type="month"') &&
    dashboardPage.includes('type="date"'),
  "Cash card includes month picker and as-of date picker for drill-down scope"
);
ok(
  dashboardPage.includes("onNavigate(\"cashflow\")"),
  "Cash card 'ดูทั้งหมด' button navigates to the dedicated cashflow page"
);
ok(
  dashboardPage.includes("const query: CashSummaryQuery = { withDetail: true }"),
  "Cash card always requests withDetail so the all-time view can list every row"
);
ok(
  dashboardPage.includes("(cashSummary.rows ?? [])") &&
    dashboardPage.includes("เรียงตามวันที่"),
  "All-time cash view renders the chronological per-transaction rows table"
);
ok(
  dashboardPage.includes("ยังไม่มีรายการเงินเข้า/ออกในบัญชี"),
  "All-time cash view has an honest empty state for the rows table"
);
ok(
  dashboardPage.includes("ตารางล่างเรียงตามวันที่ (เก่าก่อน)"),
  "Cash card footnote explains the rows are ordered oldest-first"
);
ok(
  dashboardPage.includes("เงินเข้าสะสม") &&
    dashboardPage.includes("เงินออกสะสม") &&
    dashboardPage.includes("ยอดสุทธิสะสม") &&
    dashboardPage.includes("fmtDate(cashAsOf)"),
  "As-of cash totals are labeled as accumulated (ยอดสะสม) with the cutoff date"
);
ok(
  dashboardPage.includes("cashRunningBalance") &&
    dashboardPage.includes("ยอดสะสม (THB)"),
  "As-of rows table includes a running net-balance column computed client-side"
);
ok(
  dashboardPage.includes("รายการตัดยอดถึงวันที่ {fmtDate(cashAsOf)}"),
  "As-of rows header shows the cutoff date formatted in Thai"
);
ok(
  cashFlowPage.includes("ยอดสะสม (THB)") &&
    cashFlowPage.includes("runningBalance") &&
    cashFlowPage.includes("fmtAmount(runningBalance[i])"),
  "Dedicated cash page as-of rows table also shows a client-side running balance"
);
ok(
  cashFlowPage.includes("รายการตัดยอดถึงวันที่ {fmtDate(asOf)}") &&
    cashFlowPage.includes("เงินเข้าสะสม") &&
    cashFlowPage.includes("เงินออกสะสม") &&
    cashFlowPage.includes("ยอดสุทธิสะสม"),
  "Dedicated cash page uses Thai-cutoff labels and as-of totals wording"
);

// ---------------------------------------------------------------------------
// 9. Daily stock-price table (retrieval + refresh, keyless provider).
// ---------------------------------------------------------------------------
ok(
  routesFile.includes('route("api/v1/stock-prices"') &&
    routesFile.includes('route("api/v1/stock-prices/refresh"'),
  "routes.ts registers GET /api/v1/stock-prices and POST /api/v1/stock-prices/refresh"
);
ok(
  dbSchema.includes('"stock_prices"') &&
    dbSchema.includes("close_price") &&
    dbSchema.includes("uniqueIndex(\"stock_prices_symbol_date_idx\")"),
  "schema defines the stock_prices table with a (symbol, price_date) unique index"
);
ok(
  stockPricesProvider.includes('YAHOO_FINANCE_SOURCE_NAME = "yahoo-finance"') &&
    stockPricesProvider.includes("parseYahooChartResponse") &&
    stockPricesProvider.includes("refreshStockPricesCore") &&
    stockPricesProvider.includes("isDefaultStale"),
  "stock-price provider implements the keyless daily-close source + cache staleness gate (no API key)"
);
ok(
  dbSchema.includes("NOT user-scoped") &&
    dbSchema.includes("shared by all users"),
  "schema documents that stock_prices is global market data (not user-scoped)"
);
ok(
  serverApi.includes("fetchStockQuotes") &&
    serverApi.includes("priceUpdatedAt") &&
    serverApi.includes("holdingMarketValue") &&
    serverApi.includes("holdingUnrealizedPnl"),
  "client helper exposes fetchStockQuotes + display-only market-value/unrealized-P&L helpers"
);
ok(
  dashboardPage.includes("fetchStockQuotes") &&
    dashboardPage.includes("quoteForSymbol(quotes") &&
    dashboardPage.includes("holdingMarketValue(h, quote)") &&
    dashboardPage.includes("holdingUnrealizedPnl(h, quote)"),
  "Dashboard home fetches live quotes for its holdings and renders market value + unrealized P&L"
);
ok(
  dashboardPage.includes("ราคาปัจจุบัน") &&
    dashboardPage.includes("มูลค่าตลาด") &&
    dashboardPage.includes("กำไร/ขาดทุน"),
  "holdings card exposes ราคาปัจจุบัน / มูลค่าตลาด / กำไร-ขาดทุน columns"
);
ok(
  dashboardPage.includes("พักไว้เฉพาะการแสดงผล") &&
    dashboardPage.includes("ไม่เกี่ยวข้องกับการคำนวณ"),
  "holdings card labels the live prices as display-only, never tax/ledger input"
);
ok(
  /"crons":\s*\[/.test(vercelFile) &&
    vercelFile.includes('"path": "/api/v1/stock-prices/refresh"') &&
    vercelFile.includes('"schedule": "30 22 * * *"'),
  "vercel.json schedules the daily stock-price refresh cron (22:30 UTC / 05:30 ICT)"
);

// ---------------------------------------------------------------------------
// 10. Dividend-by-stock summaries + source-document links in the GL UI.
// ---------------------------------------------------------------------------
ok(
  incomeStatementTab.includes("สรุปเงินปันผล (แยกตามหุ้น)") &&
    incomeStatementTab.includes("report.dividendsBySymbol") &&
    incomeStatementTab.includes("d.symbol") &&
    incomeStatementTab.includes("d.amountThb"),
  "Income statement tab renders a per-stock dividend summary from report.dividendsBySymbol"
);
ok(
  accountCategoryView.includes("เงินปันผลรวมตามหุ้น") &&
    accountCategoryView.includes("data.symbolSummary") &&
    accountCategoryView.includes("d.amountThb"),
  "Account detail view shows a per-stock summary header for the dividend account"
);
ok(
  !accountCategoryView.includes("ดูเอกสาร") &&
    !accountCategoryView.includes("handleDownloadLine") &&
    !accountCategoryView.includes("downloadUserDocument(") &&
    !accountCategoryView.includes("URL.createObjectURL"),
  "Account detail no longer downloads the source Statement (replaced by the transaction record)"
);
ok(
  ledgerService.includes("summarizeLinesBySymbol") &&
    ledgerService.includes("sourceDocumentId: string | null") &&
    ledgerService.includes("dividendsBySymbol"),
  "ledger-service exposes symbolSummary, sourceDocumentId lines, and per-stock dividends"
);
ok(
  serverApi.includes("GeneralLedgerSymbolSummary") &&
    serverApi.includes("dividendsBySymbol") &&
    serverApi.includes("sourceDocumentId") &&
    serverApi.includes("symbolSummary"),
  "server-api client types expose dividendsBySymbol / symbolSummary / sourceDocumentId"
);
ok(
  generalLedger.includes("export function summarizeLinesBySymbol") &&
    generalLedger.includes("export interface SymbolSummaryLine"),
  "general-ledger pure engine exposes the per-stock summary helper"
);

// ---------------------------------------------------------------------------
// 11. Document viewing: per-statement transaction records (read path only).
// ---------------------------------------------------------------------------
ok(
  routesFile.includes("api/v1/documents/:id/transactions") &&
    routesFile.includes("routes/api/documents.$id.transactions.ts"),
  "Registry: GET /api/v1/documents/:id/transactions route is registered"
);
ok(
  docTransactionsRoute.includes("verifyAuth(") &&
    docTransactionsRoute.includes("authErrorResponse(") &&
    docTransactionsRoute.includes("404") &&
    docTransactionsRoute.includes("eq(documents.id") &&
    docTransactionsRoute.includes("eq(documents.userId") &&
    docTransactionsRoute.includes("listCapitalLedgerRowsByDocument") &&
    docTransactionsRoute.includes("transactions") &&
    docTransactionsRoute.includes("stats"),
  "Document-transactions route is user-scoped, ownership-verified (safe 404), and returns rows + stats"
);
ok(
  docTransactionsRoute.includes("buyCount") &&
    docTransactionsRoute.includes("sellCount") &&
    docTransactionsRoute.includes("computableSellCount") &&
    docTransactionsRoute.includes("cashCount") &&
    docTransactionsRoute.includes("fxRates") &&
    docTransactionsRoute.includes("total"),
  "Document-transactions route derives server-authoritative stats (no client recompute)"
);
ok(
  docTransactionsRoute.includes("action") &&
    docTransactionsRoute.includes("405"),
  "Document-transactions route is GET-only (action -> 405)"
);
ok(
  documentsRoute.includes("transactionCount") &&
    documentsRoute.includes("count(") &&
    documentsRoute.includes("leftJoin(") &&
    !documentsRoute.includes("filePath"),
  "Documents list now carries per-statement transactionCount (aggregated, file path still never exposed)"
);
ok(
  serverApi.includes("fetchDocumentTransactions(") &&
    serverApi.includes("DocumentTransactionsResponse") &&
    serverApi.includes("DocumentTransactionStats") &&
    serverApi.includes("transactionCount"),
  "server-api exposes fetchDocumentTransactions + response/stat DTOs"
);
ok(
  serverApi.includes("transactions: CapitalLedgerRow[]") &&
    serverApi.includes("category?: string | null") &&
    serverApi.includes("section?: string | null"),
  "Document-transactions reuse CapitalLedgerRow incl. import classification fields"
);
ok(
  archivePage.includes("ดูธุรกรรม") &&
    archivePage.includes("fetchDocumentTransactions(") &&
    archivePage.includes("handleViewTransactions"),
  "Statement archive has a per-row ดูธุรกรรม action that fetches server rows"
);
ok(
  archivePage.includes("viewLoading") &&
    archivePage.includes("viewError") &&
    archivePage.includes("กำลังโหลดธุรกรรม") &&
    archivePage.includes("ลองใหม่") &&
    archivePage.includes("เอกสารนี้ไม่มีธุรกรรมในระบบ"),
  "Document-transactions panel has loading / error+retry / honest empty states"
);
ok(
  archivePage.includes("นำเข้าทั้งหมด") &&
    archivePage.includes("ซื้อ (BUY)") &&
    archivePage.includes("ขาย (SELL)") &&
    archivePage.includes("เงินสด (CASH)") &&
    archivePage.includes("SELL คำนวณกำไรได้") &&
    archivePage.includes("อัตราจาก Statement"),
  "Document-transactions panel renders server-authoritative summary cards"
);
ok(
  archivePage.includes("r.fxRateEffective") &&
    archivePage.includes("r.realizedGainLossThb") &&
    archivePage.includes("view.documentName") &&
    !/Number\(r\.realizedGainLossThb\)\.(toFixed|times)/.test(archivePage),
  "Document-transactions table renders server fields verbatim (no P&L/FX recompute in React)"
);
ok(
  archivePage.includes("transactionCount: d.transactionCount") &&
    archivePage.includes("doc.transactionCount") &&
    documentStorage.includes("transactionCount?: number"),
  "Archive carries the server transactionCount into each row subtitle"
);
ok(
  archivePage.includes("วันที่") &&
    archivePage.includes("รายการ") &&
    archivePage.includes("ฝั่ง") &&
    archivePage.includes("ราคา/หน่วย") &&
    archivePage.includes("ค่าธรรมเนียม") &&
    archivePage.includes("กำไร/ขาดทุน (THB)"),
  "Document-transactions table mirrors the import-preview columns"
);

// ---------------------------------------------------------------------------
// 12. Revenue-Dividends account page: the "เอกสาร" (document-download) column
//     becomes a "ธุรกรรม" (transaction-record) drill-down that shows the source
//     Capital_Transactions entry for the clicked line.
// ---------------------------------------------------------------------------
ok(
  accountCategoryView.includes(`<th className="px-5 py-3 font-medium">ธุรกรรม</th>`) &&
    !accountCategoryView.includes(`<th className="px-5 py-3 font-medium">เอกสาร</th>`),
  "Account movements table renames the Document column to ธุรกรรม"
);
ok(
  accountCategoryView.includes("ดูธุรกรรม") &&
    accountCategoryView.includes("Table2") &&
    accountCategoryView.includes("setSelectedTxId(l.sourceTransactionId)"),
  "Account movements each statement line gains a ดูธุรกรรม action driven by sourceTransactionId"
);
ok(
  !accountCategoryView.includes("ดูเอกสาร") &&
    !accountCategoryView.includes("handleDownloadLine") &&
    !accountCategoryView.includes("downloadUserDocument") &&
    !accountCategoryView.includes("กำลังดาวน์โหลด..."),
  "The old document-download button/handler is gone from the account page"
);
ok(
  serverApi.includes("fetchUserTransaction(") &&
    serverApi.includes("export interface GeneralLedgerLineView") &&
    serverApi.includes("sourceTransactionId: string | null"),
  "server-api exposes fetchUserTransaction and GeneralLedgerLineView.sourceTransactionId"
);
ok(
  ledgerService.includes("sourceTransactionId: r.entry.sourceTransactionId"),
  "ledger-service carries sourceTransactionId into each account-ledger line view"
);
ok(
  accountCategoryView.includes("selectedTxId") &&
    accountCategoryView.includes("loadTxRecord") &&
    accountCategoryView.includes("fetchUserTransaction(") &&
    accountCategoryView.includes("CapitalLedgerRow"),
  "Account page wires a drill-down transaction-record page behind ดูธุรกรรม"
);
ok(
  accountCategoryView.includes("รายละเอียดธุรกรรม") &&
    accountCategoryView.includes("ไม่พบบันทึกธุรกรรมนี้ (อาจถูกลบไปแล้ว)") &&
    accountCategoryView.includes("ลองใหม่อีกครั้ง"),
  "Transaction detail keeps the header + loading/error/not-found states"
);
ok(
  accountCategoryView.indexOf("if (selectedTxId) {") >= 0 &&
    accountCategoryView.indexOf("if (selectedTxId) {") <
      accountCategoryView.indexOf("if (selected) {") &&
    accountCategoryView.includes("const rec = txRecord") &&
    accountCategoryView.includes("กลับไป${selected.name}"),
  "Transaction record is a dedicated full-width screen (early-return before the account view)"
);
ok(
  accountCategoryView.includes("ก่อนหน้า") &&
    accountCategoryView.includes("ถัดไป") &&
    accountCategoryView.includes("รายการที่ {txIndex + 1}") &&
    accountCategoryView.includes("linkedTxIds") &&
    accountCategoryView.includes("goToTx(") &&
    accountCategoryView.includes("บันทึกธุรกรรม"),
  "The full-width record screen keeps prev/next navigation across the account's linked records"
);
ok(
  !accountCategoryView.includes("กลับไปรายการเคลื่อนไหว") &&
    !accountCategoryView.includes("{selectedTxId && ("),
  "Drill-down is one screen deep in the GL tab — no in-page panel, no two-level back"
);
ok(
  accountCategoryView.includes("วันที่") &&
    accountCategoryView.includes("หุ้น") &&
    accountCategoryView.includes("ฝั่ง") &&
    accountCategoryView.includes("อัตราจาก Statement") &&
    accountCategoryView.includes("อัตราที่ใช้จริง") &&
    accountCategoryView.includes("กำไร/ขาดทุน (บาท)"),
  "Transaction-record screen renders the server fields of the source entry"
);
ok(
  accountCategoryView.includes("rec.realizedGainLossThb") &&
    accountCategoryView.includes("ไม่คำนวณใหม่") &&
    !/Number\((rec|txRecord)\.realizedGainLossThb\)\.(toFixed|times)/.test(
      accountCategoryView
    ),
  "Transaction screen renders server fields verbatim (no P&L/FX recompute)"
);
ok(
  accountCategoryView.includes("txRecordFields(") &&
    accountCategoryView.includes("sideLabelFor") &&
    accountCategoryView.includes("if (rec.costBasis != null)") &&
    accountCategoryView.includes("if (rec.fxRateStatement != null)"),
  "Transaction screen groups fields by record category and hides empty ones"
);
ok(
  accountCategoryView.includes("selectedTxId === l.sourceTransactionId"),
  "The open transaction's source row is highlighted in the movements table"
);

// ---------------------------------------------------------------------------
// 13. Per-stock detail screen ("รายละเอียดหุ้นรายตัว") — case-by-case stocks.
// ---------------------------------------------------------------------------
ok(
  routesFile.includes("api/v1/portfolio/:symbol"),
  "app/routes.ts registers the per-stock route /api/v1/portfolio/:symbol"
);
ok(
  portfolioRoute.includes("verifyAuth") &&
    portfolioRoute.includes("authErrorResponse") &&
    portfolioRoute.includes("listCapitalLedgerRowsBySymbol") &&
    portfolioRoute.includes("journalEntryToCapitalRow"),
  "Portfolio route is authenticated and reads the per-symbol journal (user-scoped)"
);
ok(
  portfolioRoute.includes("Stock not found") &&
    portfolioRoute.includes('status: 404') &&
    /trades\.length === 0 && !holdingRow/.test(portfolioRoute),
  "Portfolio route returns a safe 404 when the caller has no trades and no holding"
);
ok(
  /SYMBOL_REGEX/.test(portfolioRoute) &&
    portfolioRoute.includes("Invalid symbol") &&
    portfolioRoute.includes('status: 400'),
  "Portfolio route validates the symbol (uppercase + regex, 400 on bad input)"
);
ok(
  /export async function action\(\)/.test(portfolioRoute) &&
    portfolioRoute.includes('"Method not allowed"') &&
    portfolioRoute.includes("status: 405"),
  "Portfolio route is read-only (action stubbed to 405)"
);
ok(
  portfolioRoute.includes("realized.plus(value)") &&
    portfolioRoute.includes("totalRealizedThb") &&
    portfolioRoute.includes("costBasisState") &&
    portfolioRoute.includes("stockPrices") &&
    portfolioRoute.includes("orderBy(desc(stockPrices.priceDate)"),
  "Portfolio totals (realized THB sum) + holding + latest close are computed server-side"
);
ok(
  serverApi.includes("export interface PortfolioDetail") &&
    serverApi.includes("fetchPortfolioDetail") &&
    serverApi.includes("PortfolioTotalsDetail") &&
    serverApi.includes("totalRealizedThb: string | null"),
  "server-api exposes PortfolioDetail DTOs + fetchPortfolioDetail client helper"
);
ok(
  dashboardPage.includes("onOpenSymbol") &&
    dashboardPage.includes("onOpenSymbol(h.symbol)") &&
    dashboardPage.includes("ดูรายละเอียดหุ้นตัวนี้"),
  "Home holdings rows are clickable → onOpenSymbol (per-stock detail)"
);
ok(
  dashboard.includes("selectedSymbol") &&
    dashboard.includes("<StockDetailPage") &&
    dashboard.includes("onOpenSymbol={(symbol) => setSelectedSymbol(symbol)}") &&
    dashboard.includes("onBack={() => setSelectedSymbol(null)}"),
  "Dashboard renders <StockDetailPage> behind the selected symbol (early branch)"
);
ok(
  stockDetailPage.includes("fetchPortfolioDetail(") &&
    stockDetailPage.includes("ธุรกรรมทั้งหมดของ") &&
    stockDetailPage.includes("รายละเอียดหุ้นรายตัว"),
  "Stock detail page loads from GET /api/v1/portfolio/:symbol and renders the trades table"
);
ok(
  stockDetailPage.includes("วันที่") &&
    stockDetailPage.includes("ฝั่ง") &&
    stockDetailPage.includes("จำนวน") &&
    stockDetailPage.includes("ราคา/หน่วย") &&
    stockDetailPage.includes("มูลค่ารวม") &&
    stockDetailPage.includes("ค่าธรรมเนียม") &&
    stockDetailPage.includes("เงินเข้า/ออก") &&
    stockDetailPage.includes("อัตรา FX") &&
    stockDetailPage.includes("กำไร/ขาดทุน (THB)"),
  "Stock detail trades table mirrors the import-preview columns"
);
ok(
  stockDetailPage.includes("กำไร/ขาดทุน (ยังไม่รับรู้)") &&
    stockDetailPage.includes("กำไร/ขาดทุนที่รับรู้แล้ว") &&
    stockDetailPage.includes("SELL ที่ยังคำนวณไม่ได้") &&
    stockDetailPage.includes("ไม่เกี่ยวข้องกับการคำนวณฐานภาษี"),
  "Stock detail shows unrealized + realized P&L honestly (non-computable rows explicit)"
);
ok(
  stockDetailPage.includes("โหลดข้อมูลหุ้น") &&
    stockDetailPage.includes("ลองใหม่") &&
    stockDetailPage.includes("ไม่พบหุ้น") &&
    stockDetailPage.includes("ยังไม่มีธุรกรรมในระบบ"),
  "Stock detail keeps loading / error+retry / not-found / empty states"
);
ok(
  !/\bDecimal\b/.test(stockDetailPage) &&
    !stockDetailPage.includes(".times(") &&
    !stockDetailPage.includes("realizedGainLossThb) *") &&
    stockDetailPage.includes("r.realizedGainLossThb") &&
    stockDetailPage.includes("notFound"),
  "Stock detail renders server fields verbatim (no P&L recompute in React)"
);
ok(
  stockDetailPage.includes("totals.totalRealizedThb") &&
    stockDetailPage.includes("holding.marketValue") &&
    stockDetailPage.includes("holding.unrealizedPnl"),
  "Stock detail consumes the server-computed holding/totals numbers directly"
);

// ---------------------------------------------------------------------------
// 13b. Trading journal (สมุดบันทึกการซื้อขาย) — daily trade log + per-stock
//      portfolio summary with replayed average cost (server-authoritative).
// ---------------------------------------------------------------------------
ok(
  tradingJournalEngine.includes("export function buildTradingJournalEntries") &&
    tradingJournalEngine.includes("export function classifyJournalSide") &&
    tradingJournalEngine.includes("export function isTradeJournalRow") &&
    tradingJournalEngine.includes("avgCostAtTime") &&
    tradingJournalEngine.includes('type JournalSide = "BUY" | "SELL" | "DIVIDEND"') &&
    !tradingJournalEngine.includes("แลกเปลี่ยน") &&
    !tradingJournalEngine.includes("ดอกเบี้ย") &&
    !tradingJournalEngine.includes("กำไรจากการขาย"),
  "Trading-journal engine replays the average-cost map and only ever speaks BUY/SELL/DIVIDEND (no FX/interest/gain kinds)"
);
ok(
  tradingJournalRoute.includes("GET /api/v1/trading-journal") &&
    tradingJournalRoute.includes("verifyAuth") &&
    tradingJournalRoute.includes("listCapitalLedgerRows") &&
    tradingJournalRoute.includes("action") &&
    tradingJournalRoute.includes("405"),
  "Trading-journal route is a user-scoped GET-only read from the journal"
);
ok(
  tradingJournalRoute.includes("from") &&
    tradingJournalRoute.includes("to") &&
    tradingJournalRoute.includes("symbol") &&
    tradingJournalRoute.includes("side") &&
    tradingJournalRoute.includes("Invalid"),
  "Trading-journal route accepts from/to/symbol/side filters with 400 on invalid values"
);
ok(
  tradingJournalRoute.includes("DIVIDEND") &&
    tradingJournalRoute.includes("addRealized") &&
    !tradingJournalRoute.includes("INTEREST") &&
    !tradingJournalRoute.includes("GAIN") &&
    !tradingJournalRoute.includes("fxCount") &&
    !tradingJournalRoute.includes("แลกเปลี่ยน") &&
    tradingJournalRoute.includes("side=BUY|SELL|DIVIDEND"),
  "Trading-journal realized P&L counts dividend income only — no interest/gain/FX kinds anywhere"
);
ok(
  tradingJournalRoute.includes("pnlSummary") &&
    tradingJournalRoute.includes("realizedGainThb") &&
    tradingJournalRoute.includes("nonComputableSellCount") &&
    tradingJournalRoute.includes("combinedThb"),
  "Trading-journal route computes a period P&L summary (gains + income + unrealized, non-computable counted)"
);
ok(
  tradingJournalEngine.includes("export function buildBehaviorStats") &&
    tradingJournalRoute.includes("buildBehaviorStats") &&
    tradingJournalRoute.includes("behavior") &&
    tradingJournalEngine.includes("winRate") &&
    tradingJournalEngine.includes("profitFactor") &&
    tradingJournalEngine.includes("avgHoldingDays"),
  "Trading-journal behavior stats are computed server-side (win rate, profit factor, best/worst, holding period)"
);
ok(
  tradingJournalMigration.includes('"note"') &&
    tradingJournalMigration.includes("journal_entries") &&
    dbSchema.includes('note: text("note")'),
  "Journal note column exists end-to-end (migration 0022 + schema)"
);
ok(
  tradingJournalNoteRoute.includes("PUT /api/v1/trading-journal/:transactionId/note") &&
    tradingJournalNoteRoute.includes("verifyAuth") &&
    tradingJournalNoteRoute.includes("sourceTransactionId") &&
    tradingJournalNoteRoute.includes("Record not found") &&
    tradingJournalNoteRoute.includes("405"),
  "Journal note route is owner-scoped (PUT set / DELETE clear, safe 404, loader 405)"
);
ok(
  routesFile.includes('"api/v1/trading-journal/:transactionId/note"') &&
    routesFile.includes('"routes/api/trading-journal.$transactionId.note.ts"'),
  "Journal note route is registered in app/routes.ts"
);
ok(
  serverApi.includes("TradingJournalResponse") &&
    serverApi.includes("TradingJournalEntry") &&
    serverApi.includes("TradingJournalHolding") &&
    serverApi.includes("fetchTradingJournal") &&
    !serverApi.includes("fxCount"),
  "server-api exposes TradingJournal DTOs + fetchTradingJournal client helper (no FX totals)"
);
ok(
  serverApi.includes("updateJournalNote") &&
    serverApi.includes("TradingJournalPnlSummary") &&
    serverApi.includes("TradingJournalBehaviorStats"),
  "server-api exposes updateJournalNote + P&L/behavior DTOs"
);
ok(
  routesFile.includes('route("api/v1/trading-journal"'),
  "Trading-journal route is registered in app/routes.ts"
);
ok(
  dashboard.includes('"trading"') &&
    dashboard.includes("สมุดบันทึกการซื้อขาย") &&
    dashboard.includes("<TradingJournalPage"),
  "Dashboard nav gains a สมุดบันทึกการซื้อขาย entry and renders the page"
);
ok(
  tradingJournalPage.includes("fetchTradingJournal(") &&
    tradingJournalPage.includes("วัน/เดือน/ปี") &&
    tradingJournalPage.includes("ซื้อ/ขาย/ได้ปันผล") &&
    tradingJournalPage.includes("ชื่อย่อหุ้น") &&
    tradingJournalPage.includes("เงินปันผล/หุ้น") &&
    tradingJournalPage.includes("จำนวนหุ้น") &&
    tradingJournalPage.includes("จำนวนเงิน") &&
    tradingJournalPage.includes("ค่าธรรมเนียม/ภาษี") &&
    tradingJournalPage.includes("มูลค่าสุทธิ") &&
    tradingJournalPage.includes("ต้นทุนเฉลี่ย/หุ้น"),
  "Trading-journal table renders the 10 spec columns from server fields"
);
ok(
  tradingJournalPage.includes("fmtNum(e.price)") &&
    tradingJournalPage.includes("{e.currency}") &&
    tradingJournalPage.includes('text-[10px] text-gray-400 font-normal'),
  "Trading-journal price cell shows the trade currency unit beside the price (e.g. 150.00 USD)"
);
ok(
  tradingJournalRoute.includes("const tradeRows = journalRows.filter((r) =>") &&
    tradingJournalRoute.includes("buildTradingJournalEntries(tradeRows, corporateActionRows)") &&
    tradingJournalRoute.includes("let scopedEntries = fullEntries;") &&
    tradingJournalRoute.includes("e.date >= from") &&
    tradingJournalRoute.includes("e.date <= to") &&
    tradingJournalRoute.includes("entrySymbolOf(e) === symbol") &&
    tradingJournalRoute.includes("buildBehaviorStats(scopeRows, corporateActionRows)") &&
    tradingJournalRoute.includes("corporateActionRows: CorporateActionInput[] = []") &&
    tradingJournalRoute.includes("corporateActionsTable.parentFmvPerShare") &&
    tradingJournalRoute.includes("corporateActionsTable.childFmvPerShare"),
  "Trading-journal route replays the average over the full lifetime + corporate actions, then applies date/symbol filters to the built entries (no window drift)"
);
ok(
  tradingJournalRoute.includes("holdingBySymbol.has(sym)") &&
    tradingJournalRoute.includes(
      "Only symbols the caller still holds get a card"
    ),
  "Trading-journal summary shows cards only for currently-held symbols (fully-sold positions drop out of the cards, stay in the table)"
);
ok(
  tradingJournalPage.includes("PAGE_SIZE = 20") &&
    tradingJournalPage.includes("entries.slice(pageStart") &&
    tradingJournalPage.includes("Math.min(page, pageCount)") &&
    tradingJournalPage.includes("ก่อนหน้า") &&
    tradingJournalPage.includes("ถัดไป") &&
    tradingJournalPage.includes("หน้า {safePage}/{pageCount}") &&
    tradingJournalPage.includes("setPage(1)") &&
    tradingJournalPage.includes("รายการ {pageStart + 1}"),
  "Trading-journal table paginates 20 rows per page with a pager (resets to page 1 on filter change)"
);
ok(
  tradingJournalPage.includes("แสดงเฉพาะหุ้นที่ยังถืออยู่"),
  "Trading-journal holdings section states it shows currently-held stocks only"
);
ok(
  tradingJournalPage.includes("สรุปหุ้นในพอร์ตรายตัว") &&
    tradingJournalPage.includes("หุ้นคงเหลือ") &&
    tradingJournalPage.includes("ผลตอบแทนยังไม่ขาย") &&
    tradingJournalPage.includes("กำไร/รายได้ที่รับรู้แล้ว") &&
    tradingJournalPage.includes("มูลค่าตลาด (ราคาปิด)") &&
    tradingJournalPage.includes("ไม่ใช่ราคา real-time"),
  "Trading-journal page shows the per-stock portfolio summary (holdings + returns, closing-price labeled)"
);
ok(
  !tradingJournalPage.includes("แลกเปลี่ยนสกุลเงิน") &&
    !tradingJournalPage.includes("แลกเงิน") &&
    !tradingJournalPage.includes("ต้นทาง→ปลายทาง") &&
    !tradingJournalPage.includes("ดอกเบี้ย") &&
    !tradingJournalPage.includes("กำไรจากการขาย") &&
    tradingJournalPage.includes("สมุดเล่มนี้แสดงเฉพาะการซื้อขายหุ้น"),
  "Trading-journal page shows stock trades only — no แลกเปลี่ยน / ดอกเบี้ย / กำไรจากการขาย words anywhere"
);
ok(
  tradingJournalPage.includes("onOpenSymbol") &&
    tradingJournalPage.includes("onOpenSymbol(e.symbol") &&
    tradingJournalPage.includes("onOpen={() => onOpenSymbol(h.symbol)}"),
  "Trading-journal rows and holding cards navigate to the per-stock detail"
);
ok(
  tradingJournalPage.includes("updateJournalNote(") &&
    tradingJournalPage.includes("จดบันทึก") &&
    tradingJournalPage.includes("จดบันทึกของฉัน") &&
    tradingJournalPage.includes("onNoteSaved") &&
    tradingJournalPage.includes("กำลังบันทึก"),
  "Trading-journal rows carry an inline investor-note editor (open/edit/save/clear)"
);
ok(
  !tradingJournalPage.includes("สรุปกำไร/ขาดทุน") &&
    !tradingJournalPage.includes("pnlSummary.") &&
    !tradingJournalPage.includes("พฤติกรรมการลงทุน") &&
    !tradingJournalPage.includes("behavior.") &&
    !tradingJournalPage.includes("PnlCard"),
  "Trading-journal P&L-summary and behavior-stat cards removed from the page (server still computes the fields for later use)"
);
ok(
  !/\bDecimal\b/.test(tradingJournalPage) &&
    !tradingJournalPage.includes(".times(") &&
    tradingJournalPage.includes("avgCostAtTime"),
  "Trading-journal page renders server fields verbatim (no P&L recompute in React)"
);

// ---------------------------------------------------------------------------
// 14. Journal-as-SSOT Phase 2: consumers read the journal; manual rows journaled.
// ---------------------------------------------------------------------------
const capitalLedgersRoute = read("app/routes/api/capital-ledgers.ts");
const capitalLedgerIdRoute = read("app/routes/api/capital-ledgers.$id.ts");
const cashSummaryLib = read("app/lib/cash-summary.ts");
const journalLedgerRead = read("app/lib/journal-ledger-read.ts");
ok(
  journalLedgerRead.includes("export function journalEntryToCapitalRow") &&
    journalLedgerRead.includes("export async function listCapitalLedgerRows") &&
    journalLedgerRead.includes("export async function getCapitalLedgerRow") &&
    journalLedgerRead.includes("export async function listCapitalLedgerRowsByDocument") &&
    journalLedgerRead.includes("export async function listCapitalLedgerRowsBySymbol") &&
    journalLedgerRead.includes("export async function listCashSummaryRows"),
  "journal-ledger-read exposes the mapper + all 5 journal read helpers"
);
ok(
  capitalLedgersRoute.includes("listCapitalLedgerRows") &&
    capitalLedgersRoute.includes("journalEntryToCapitalRow") &&
    !/\bfrom\(capitalTransactions\)/.test(capitalLedgersRoute),
  "Capital-ledgers GET list is served from the journal (no Capital_Transactions query)"
);
ok(
  capitalLedgersRoute.includes("insertManualCashJournal") &&
    capitalLedgersRoute.includes("journalEntryNo"),
  "Capital-ledgers POST mirrors manual rows into the journal + reports entryNo"
);
ok(
  capitalLedgerIdRoute.includes("getCapitalLedgerRow") &&
    capitalLedgerIdRoute.includes("journalEntryToCapitalRow"),
  "Capital-ledgers single GET is served from the journal"
);
ok(
  journalLedgerRead.includes("note: journalEntries.note") &&
    tradingJournalEngine.includes("note: r.note"),
  "Journal note flows through the read layer into trading-journal entries"
);
ok(
  capitalLedgerIdRoute.includes("syncCapitalLedgerJournal") &&
    capitalLedgerIdRoute.includes("removeCapitalLedgerJournal"),
  "Capital-ledgers PUT/DELETE keep the mirrored journal entry in sync"
);
ok(
  cashSummaryLib.includes("listCashSummaryRows") &&
    cashSummaryLib.includes("journalEntryToCapitalRow") &&
    !cashSummaryLib.includes("from(capitalTransactions)"),
  "Cash summary is aggregated from the journal rows"
);
ok(
  portfolioRoute.includes("listCapitalLedgerRowsBySymbol") &&
    portfolioRoute.includes("journalEntryToCapitalRow"),
  "Per-stock detail reads the symbol's journal rows"
);
ok(
  docTransactionsRoute.includes("listCapitalLedgerRowsByDocument") &&
    docTransactionsRoute.includes("journalEntryToCapitalRow"),
  "Document-transactions read the document's journal rows"
);
ok(
  ledgerService.includes("export async function insertManualCashJournal") &&
    ledgerService.includes("export async function syncCapitalLedgerJournal") &&
    ledgerService.includes("export async function removeCapitalLedgerJournal") &&
    ledgerService.includes("MANUAL_CASH_THB") &&
    ledgerService.includes("MANUAL_EQUITY_CAPITAL"),
  "ledger-service persists/rebuilds/removes the manual-cash journal entries"
);
ok(
  dbSchema.includes('type: text("type")') &&
    dbSchema.includes("source_transaction_id"),
  "journal_entries persists the manual cash type + source_transaction_id index"
);

// ---------------------------------------------------------------------------
// 15. Journal-as-SSOT Phase 3: legacy Capital_Transactions backfill script.
// ---------------------------------------------------------------------------
const backfillSsot = read("scripts/backfill-journal-ssot.mts");
ok(
  backfillSsot.includes("insertBackfilledJournalEntry") &&
    backfillSsot.includes("insertManualCashJournal") &&
    backfillSsot.includes("journalDetailOf") &&
    backfillSsot.includes("statementDescriptionFor"),
  "Backfill script reuses the journal insert helpers + pure detail/description builders"
);
ok(
  backfillSsot.includes("sourceTransactionId: row.transactionId") &&
    backfillSsot.includes("sourceDocumentId: row.sourceDocumentId") &&
    backfillSsot.includes("type: row.type"),
  "Backfill links every mirror entry to its Capital_Transactions row (id + document + type)"
);
ok(
  backfillSsot.includes("`${e.entryDate}|${e.description}`") &&
    backfillSsot.includes("alreadyMirrored") &&
    backfillSsot.includes("linkLegacy"),
  "Backfill matches legacy GL postings by entry_date + description and skips already-mirrored rows"
);
ok(
  backfillSsot.includes("backfilled-record-only") &&
    backfillSsot.includes("backfilled-ambiguous-legacy") &&
    backfillSsot.includes("postingState: \"SKIPPED\""),
  "Backfill records unmatched rows as line-less SKIPPED mirrors (never invents postings)"
);
ok(
  backfillSsot.includes("--dry-run") &&
    backfillSsot.includes("nothing will be written"),
  "Backfill supports a dry-run preview"
);
ok(
  ledgerService.includes("export interface BackfilledJournalEntryInput") &&
    ledgerService.includes("export async function insertBackfilledJournalEntry") &&
    ledgerService.includes("lines: []") &&
    ledgerService.includes('skipReason: input.skipReason ?? "backfilled-record-only"'),
  "ledger-service backfill helper is a SKIPPED line-less record insert (never fabricates lines)"
);

// ---------------------------------------------------------------------------
// 16. Currency exchange display — migration + read layer + cash-summary + UI block.
// ---------------------------------------------------------------------------
ok(
  exchangeMigration.includes("exchange_from_currency") &&
    exchangeMigration.includes("exchange_from_amount") &&
    exchangeMigration.includes("exchange_rate"),
  "0021 migration adds exchange_from_currency + exchange_from_amount + exchange_rate columns"
);
ok(
  dbSchema.includes('exchangeFromCurrency: text("exchange_from_currency")') &&
    dbSchema.includes('exchangeFromAmount: numeric("exchange_from_amount")') &&
    dbSchema.includes('exchangeRate: numeric("exchange_rate")'),
  "schema.ts declares exchangeFromCurrency / exchangeFromAmount / exchangeRate on capitalTransactions"
);
ok(
  dbSchema.includes("exchange_from_currency") &&
    dbSchema.includes("exchange_from_amount") &&
    dbSchema.includes("exchange_rate"),
  "schema.ts also declares the same columns on journalEntries"
);
ok(
  statementPipeline.includes('typeof t.exchangeFromCurrency === "string"') &&
    statementPipeline.includes("exchangeFromCurrency:") &&
    statementPipeline.includes("exchangeFromAmount:") &&
    statementPipeline.includes("exchangeRate:"),
  "statement-pipeline maps exchange fields from ExtractedTransaction into ValidatedCapitalRow"
);
ok(
  journalLedgerRead.includes("listFxConversionRows") &&
    journalLedgerRead.includes("isFxConversion") &&
    journalLedgerRead.includes("exchangeFromCurrency") &&
    journalLedgerRead.includes("exchangeFromAmount"),
  "journal-ledger-read exposes listFxConversionRows and carries exchange fields through"
);
ok(
  cashSummaryLib.includes("CashSummaryExchangeRow") &&
    cashSummaryLib.includes("CashSummaryExchangeTotal") &&
    cashSummaryLib.includes("buildCashExchangeRows") &&
    cashSummaryLib.includes("exchanges:") &&
    cashSummaryLib.includes("exchangeTotals:"),
  "cash-summary exposes exchange types + buildCashExchangeRows + CashSummary.exchanges/exchangeTotals"
);
ok(
  cashSummaryLib.includes("e.sourceTransactionId") &&
    cashSummaryLib.includes("e.entryDate") &&
    cashSummaryLib.includes("e.exchangeFromCurrency"),
  "getCashSummary maps exchange row fields from journal records (not fabricated)"
);
ok(
  cashFlowPage.includes("การแลกเปลี่ยนสกุลเงิน") &&
    cashFlowPage.includes("fromCurrency") &&
    cashFlowPage.includes("toCurrency") &&
    cashFlowPage.includes("fromAmount") &&
    cashFlowPage.includes("exchangeTotals") &&
    cashFlowPage.includes("ยังไม่มีรายการแลกเปลี่ยนสกุลเงิน"),
  "CashFlowPage renders the exchange section with from/to fields, per-currency totals, and honest empty state"
);
ok(
  serverApi.includes("CashSummaryExchangeRow") &&
    serverApi.includes("CashSummaryExchangeTotal") &&
    serverApi.includes("exchanges: CashSummaryExchangeRow[]") &&
    serverApi.includes("exchangeTotals: CashSummaryExchangeTotal[]"),
  "server-api DTO carries CashSummaryExchangeRow + CashSummaryExchangeTotal + cash-summary fields"
);
ok(
  cashFlowPage.includes("รายการแลกเปลี่ยนสกุลเงินทั้งหมด (ทุกช่วงเวลา)") &&
    cashFlowPage.includes("เป็นการย้าย") &&
    cashFlowPage.includes("เงินสดระหว่างสกุล ไม่ใช่รายรับ/รายจ่าย"),
  "Exchange section footnote honestly describes the nature of exchange rows"
);

// --- Currency exchange as its own top-of-page view (approved) ---
ok(
  cashFlowPage.includes('(["all", "month", "asOf", "exchange"] as const)') &&
    cashFlowPage.includes('? "ตัดยอด ณ วันที่"') &&
    cashFlowPage.includes(': "แลกเปลี่ยนสกุลเงิน"}'),
  "CashFlowPage view switcher includes the dedicated exchange button"
);
ok(
  cashFlowPage.includes("type CashView = \"all\" | \"month\" | \"asOf\" | \"exchange\"") &&
    cashFlowPage.includes('{view === "exchange"'),
  "CashFlowPage adds the 'exchange' view value + branch"
);
ok(
  cashFlowPage.includes("{view !== \"exchange\" && (") &&
    cashFlowPage.includes("Money in/out — shown only outside the dedicated exchange view") &&
    cashFlowPage.includes("{view === \"exchange\" && (") &&
    cashFlowPage.includes("Currency exchange — shown only in the dedicated exchange view"),
  "Money section and exchange section are mutually exclusive (exchange shown alone at the top)"
);
ok(
  cashFlowPage.includes('view === "exchange" ? "การแลกเปลี่ยนสกุลเงิน" : "เงินเข้า / เงินออก"') &&
    cashFlowPage.includes("รายการแลกเปลี่ยนสกุลเงินทั้งหมด (ย้ายเงินสดระหว่างสกุล)"),
  "Exchange view title + subtitle replace the money in/out banner labels"
);
ok(
  cashFlowPage.includes("รายการแลกเปลี่ยนสกุลเงินทั้งหมด (ทุกช่วงเวลา) — เป็นการย้าย") &&
    !cashFlowPage.includes('เฉพาะเดือน ${month}"'),
  "Exchange view is always all-time (no month/asOf suffix in the footnote)"
);

// --- Currency-exchange direction comparison (back-into-THB vs out-of-THB) ---
ok(
  cashSummaryLib.includes("CashExchangeDirectionTotals") &&
    cashSummaryLib.includes("buildExchangeDirectionTotals") &&
    cashSummaryLib.includes("exchangeDirectionTotals:") &&
    cashSummaryLib.includes("moreInThanOut"),
  "cash-summary defines the direction-comparison type + pure builder + wire-in field"
);
ok(
  cashSummaryLib.includes("intoThbTotal") &&
    cashSummaryLib.includes("intoThbCount") &&
    cashSummaryLib.includes("outOfThbTotal") &&
    cashSummaryLib.includes("outOfThbCount") &&
    cashSummaryLib.includes("netThb"),
  "direction totals carry into/out THB sums + counts + netThb (THB comparison)"
);
ok(
  serverApi.includes("CashExchangeDirectionTotals") &&
    serverApi.includes("exchangeDirectionTotals: CashExchangeDirectionTotals"),
  "server-api DTO carries CashExchangeDirectionTotals on CashSummary"
);
ok(
  cashFlowPage.includes("exchangeDirectionTotals") &&
    cashFlowPage.includes("เงินกลับเข้าบาท") &&
    cashFlowPage.includes("เงินออกจากบาท") &&
    cashFlowPage.includes("grid grid-cols-2"),
  "CashFlowPage reads exchangeDirectionTotals and renders a 2-column visual (in vs out)"
);
ok(
  cashFlowPage.includes("moreInThanOut") &&
    cashFlowPage.includes("กลับเข้ามากว่า") &&
    cashFlowPage.includes("ออกไปมากกว่า") &&
    cashFlowPage.includes("Math.abs") &&
    cashFlowPage.includes("text-center mt-2"),
  "CashFlowPage renders the net verdict centered: more-back (emerald) vs more-out (red), magnitude only"
);
ok(
  cashFlowPage.includes("dirTotals.intoThbCount > 0 || dirTotals.outOfThbCount > 0"),
  "Direction summary only renders when at least one direction has data (honest empty)"
);
ok(
  cashFlowPage.includes('x.fromCurrency ?? "ไม่ทราบสกุล"') &&
    cashFlowPage.includes("bg-blue-50 text-blue-900") &&
    cashFlowPage.includes("rounded-full"),
  "Direction cell renders from/to as colored badges (THB blue) with 'ไม่ทราบสกุล' kept only as a dead guard"
);
ok(
  cashFlowPage.includes("จำนวนเงินต้นทาง") &&
    cashFlowPage.includes("จำนวนเงินปลายทาง") &&
    cashFlowPage.slice(cashFlowPage.indexOf("{/* Currency exchange")).includes("ทิศทาง") &&
    !cashFlowPage.slice(cashFlowPage.indexOf("{/* Currency exchange")).includes("จำนวนเงิน (THB)") &&
    !cashFlowPage.slice(cashFlowPage.indexOf("{/* Currency exchange")).includes("จำนวนจาก") &&
    !cashFlowPage.slice(cashFlowPage.indexOf("{/* Currency exchange")).includes("จำนวนถึง"),
  "Exchange table has 5 clear columns (date / direction / from-amount / to-amount / rate) — redundant THB column removed"
);
ok(
  cashFlowPage.includes("fromAmount") &&
    cashFlowPage.includes("fromCurrency ??") &&
    cashFlowPage.includes("toAmount") &&
    cashFlowPage.includes("toCurrency ??"),
  "Amount cells show the currency unit inline (e.g. 4,999.80 THB)"
);
ok(
  cashFlowPage.slice(cashFlowPage.indexOf("{/* Currency exchange")).includes("colSpan={5}") &&
    !cashFlowPage.slice(cashFlowPage.indexOf("{/* Currency exchange")).includes("colSpan={6}"),
  "Exchange empty-state spans the new 5 columns"
);
ok(
  cashFlowPage.includes("showExchangeLegend") &&
    cashFlowPage.includes("วิธีอ่าน") &&
    cashFlowPage.includes("วิธีอ่านตารางแลกเปลี่ยน") &&
    cashFlowPage.includes("จำนวนเงินต้นทาง") &&
    cashFlowPage.includes("ไม่ใช่รายรับ/รายจ่าย"),
  "Exchange section has a collapsed 'วิธีอ่าน' legend toggle with comprehension bullets"
);
ok(
  cashFlowPage.includes("รายการแลกเปลี่ยนสกุลเงินทั้งหมด (ทุกช่วงเวลา)") &&
    cashFlowPage.includes("เป็นการย้าย") &&
    cashFlowPage.includes("เงินสดระหว่างสกุล ไม่ใช่รายรับ/รายจ่าย") &&
    !cashFlowPage.includes("ไม่ทราบสกุล → ปลายทาง"),
  "Exchange footnote describes exchanges without any legacy-'ไม่ทราบสกุล' note (data backfilled)"
);

// --- Exchange from-side backfill (legacy rows, migration-0021 gap) ---
const backfillExchange = read("scripts/backfill-exchange-from-fields.mts");
ok(
  backfillExchange.includes("exchange_from_currency IS NULL") &&
    backfillExchange.includes("is_fx_conversion = true") &&
    backfillExchange.includes("แลกเปลี่ยนสกุลเงิน"),
  "Backfill targets exactly the legacy rows: NULL from-fields on exchange rows in both tables"
);
ok(
  backfillExchange.includes("--dry-run") &&
    backfillExchange.includes("no changes written") &&
    backfillExchange.includes("DRY RUN"),
  "Backfill supports a dry-run preview"
);
ok(
  backfillExchange.includes("amount_thb") &&
    backfillExchange.includes("fx_rate_effective") &&
    backfillExchange.includes("0.02"),
  "Backfill derives from_amount/rate from stored THB values with a consistency check (never invents)"
);

// --- Portfolio chart in GL overview (same component as Dashboard home) ---
const overviewTab = read("app/component/LedgerRedesign/OverviewTab.tsx");
const glNew = read("app/component/LedgerRedesign/GeneralLedgerNew.tsx");
ok(
  overviewTab.includes(
    'import PortfolioChart from "../DashboardUser/PortfolioChart"'
  ) &&
    overviewTab.includes("fetchStockQuotes") &&
    overviewTab.includes("h.map((x) => x.symbol)") &&
    overviewTab.includes("Promise.allSettled"),
  "GL overview reuses the Dashboard PortfolioChart and loads daily quotes only when holdings exist"
);
ok(
  overviewTab.indexOf("<PortfolioChart") <
    overviewTab.lastIndexOf('<table className="w-full text-sm">') &&
    overviewTab.includes("onOpenSymbol={onOpenSymbol}"),
  "GL overview renders the portfolio chart above the untouched holdings table with click-through"
);
ok(
  glNew.includes("onOpenSymbol?: (symbol: string) => void") &&
    glNew.includes("<OverviewTab onOpenSymbol") &&
    dashboard.includes("onOpenSymbol={(symbol) => setSelectedSymbol(symbol)}"),
  "Stock-detail drill-down is wired GL overview -> shell (same StockDetailPage as Dashboard home)"
);
ok(
  overviewTab.includes("onClick={() => onOpenSymbol(h.symbol)}") &&
    overviewTab.includes("ดูรายละเอียดหุ้นตัวนี้") &&
    overviewTab.includes("คลิกที่สัญลักษณ์เพื่อดูรายละเอียดหุ้นรายตัว"),
  "GL holdings table symbols are clickable (same per-stock drill-down as Dashboard home)"
);

// --- Portfolio chart on หน้าหลัก (donut + bar, market value, above holdings table) ---
const portfolioChart = read("app/component/DashboardUser/PortfolioChart.tsx");
ok(
  portfolioChart.includes("holdingMarketValue") &&
    portfolioChart.includes("quoteForSymbol") &&
    !portfolioChart.includes("holdingUnrealizedPnl(") &&
    !portfolioChart.includes("fetchStockQuotes") &&
    !portfolioChart.includes("fetchCostBasis"),
  "PortfolioChart reuses server helpers (holdingMarketValue/quoteForSymbol) and fetches nothing itself"
);
ok(
  portfolioChart.includes("<Pie") &&
    portfolioChart.includes("innerRadius") &&
    portfolioChart.includes("<BarChart") &&
    portfolioChart.includes('layout="vertical"') &&
    portfolioChart.includes("<ResponsiveContainer"),
  "PortfolioChart renders a donut (Pie with innerRadius) + horizontal bars in ResponsiveContainers (recharts already in deps)"
);
ok(
  portfolioChart.includes("missingCount") &&
    portfolioChart.includes("ยังคำนวณสัดส่วนพอร์ตไม่ได้") &&
    portfolioChart.includes("ไม่เกี่ยวข้องกับการคำนวณฐานภาษี"),
  "PortfolioChart honestly excludes holdings without a daily close and labels prices display-only"
);
ok(
  portfolioChart.includes("onOpenSymbol") &&
    portfolioChart.includes("handleSelect"),
  "Chart slices/bars/legend click through to the per-stock detail (onOpenSymbol)"
);
ok(
  dashboardPage.includes('import PortfolioChart from "./PortfolioChart"') &&
    dashboardPage.includes("<PortfolioChart") &&
    dashboardPage.indexOf("<PortfolioChart") <
      dashboardPage.indexOf('<table className="w-full text-sm">'),
  "DashboardHomePage renders PortfolioChart above the untouched holdings table"
);

// --- 17. Client-side search in every feature (no backend change) ---
const chartOfAccountsTab = read("app/component/Ledger/ChartOfAccountsTab.tsx");
const adminDashboard = read("app/component/Admin/Admindashboard.tsx");
ok(
  archivePage.includes('placeholder="ค้นหาชื่อไฟล์…"') &&
    archivePage.includes("filteredDocs") &&
    archivePage.includes("doc.fileName.toLowerCase().includes(query.trim().toLowerCase())") &&
    archivePage.includes("พบ {filteredDocs.length} จาก {docs.length} ไฟล์") &&
    archivePage.includes("ไม่พบไฟล์ที่ค้นหา"),
  "Archive has a filename search (client filter + count + honest empty, folders unchanged)"
);
ok(
  chartOfAccountsTab.includes("filteredAccounts") &&
    chartOfAccountsTab.includes('placeholder="ค้นหารหัส ชื่อ ประเภท หรือสกุลเงิน…"') &&
    chartOfAccountsTab.includes("พบ {filteredAccounts.length} จาก {accounts.length} บัญชี") &&
    chartOfAccountsTab.includes("ไม่พบรายการที่ค้นหา") &&
    chartOfAccountsTab.includes("{filteredAccounts.map((row) => ("),
  "ChartOfAccountsTab filters code/name/type/currency client-side (counters stay period-based)"
);
ok(
  accountCategoryView.includes("filteredAccounts") &&
    accountCategoryView.includes('placeholder="ค้นหารหัส ชื่อ หรือสกุลเงิน…"') &&
    accountCategoryView.includes("พบ {filteredAccounts.length} จาก {accounts.length} บัญชี") &&
    accountCategoryView.includes("ไม่พบรายการที่ค้นหา") &&
    accountCategoryView.includes("{filteredAccounts.map((row) => {"),
  "AccountCategoryView account list has the same client-side search"
);
ok(
  routesFile.includes("api/v1/ledger/accounts/summary"),
  "batch account-category summary route is registered (static segment outranks :accountId)"
);
{
  const summaryRoute = read("app/routes/api/ledger.accounts.summary.ts");
  ok(
    summaryRoute.includes("getAccountCategorySummary") &&
      summaryRoute.includes("ACCOUNT_TYPES") &&
      summaryRoute.includes('["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]') &&
      summaryRoute.includes("isValidIsoDate") &&
      summaryRoute.includes("seedDefaultChartOfAccounts") &&
      summaryRoute.includes('status: 405') &&
      summaryRoute.includes("Method not allowed"),
    "summary route validates type + ISO dates, seeds CoA, GET-only 405"
  );
}
ok(
  ledgerService.includes("getAccountCategorySummary") &&
    ledgerService.includes("inArray(journalEntryLines.accountId, ids)") &&
    ledgerService.includes("summarizeAccountLedgers(inputs, lines, from)"),
  "ledger-service fetchless batch service: one inArray query + pure engine partition"
);
ok(
  generalLedger.includes("export function summarizeAccountLedgers") &&
    generalLedger.includes("AccountLedgerSummaryRow") &&
    generalLedger.includes("AccountLedgerSummaryCurrencyTotal") &&
    generalLedger.includes("debitMovement") &&
    generalLedger.includes("creditMovement") &&
    generalLedger.includes("netMovement") &&
    generalLedger.includes("lineCount"),
  "pure engine exports the batch summary (native-currency rows + grouped totals)"
);
ok(
  serverApi.includes("fetchAccountCategorySummary") &&
    serverApi.includes("GeneralLedgerAccountCategorySummary") &&
    serverApi.includes("/api/v1/ledger/accounts/summary?") &&
    serverApi.includes("import(\"./general-ledger\").AccountLedgerSummaryRow"),
  "server-api client has the batch category-summary fetch + types"
);
ok(
  accountCategoryView.includes("fetchAccountCategorySummary") &&
    !accountCategoryView.includes("fetchAccounts(") &&
    accountCategoryView.includes("setAccounts(summary.accounts)") &&
    accountCategoryView.includes("new Map<string, GeneralLedgerAccountCategoryRow>()") &&
    accountCategoryView.includes("summaryRows.get(row.id)") &&
    accountCategoryView.includes("categoryTotals") &&
    accountCategoryView.includes("ยอดคงเหลือตามสกุล") &&
    accountCategoryView.includes("ดูรายละเอียด"),
  "AccountCategoryView: batch summary fetched in loadAccounts, row map, per-currency totals"
);
ok(
  accountCategoryView.includes("<th className=\"px-5 py-3 font-medium text-right\">ยอดยกมา</th>") &&
    accountCategoryView.includes("<th className=\"px-5 py-3 font-medium text-right\">เคลื่อนไหว</th>") &&
    accountCategoryView.includes("<th className=\"px-5 py-3 font-medium text-right\">ยอดคงเหลือ</th>") &&
    accountCategoryView.includes("<th className=\"px-5 py-3 font-medium text-right\">จำนวนรายการ</th>"),
  "category table headers: ยอดยกมา / เคลื่อนไหว / ยอดคงเหลือ / จำนวนรายการ"
);
ok(
  accountCategoryView.includes("{s ? formatAmount(ownerSignedFromNormalSide(row.type, s.opening) ?? s.opening) : \"-\"}") &&
    accountCategoryView.includes("{s ? formatSignedAmount(ownerSignedFromNormalSide(row.type, s.netMovement) ?? \"0\") : \"-\"}") &&
    accountCategoryView.includes("{s ? formatSignedAmount(ownerSignedFromNormalSide(row.type, s.closing) ?? \"0\") : \"-\"}") &&
    accountCategoryView.includes('{s ? s.lineCount : "-"}'),
  "category cells render server summary owner-signed via ownerSignedFromNormalSide (opening/movement/closing/count)"
);
ok(
  !accountCategoryView.includes("ยอดยกมารวม") &&
    !accountCategoryView.includes("formatBaht") &&
    accountCategoryView.includes("filteredAccounts.map((row) => {"),
  "no fake ฿ total; list renders from the batch-summary row map"
);
ok(
  accountCategoryView.includes("ยอดคงเหลือตามสกุล") &&
    accountCategoryView.includes("(ยกมา {formatAmount(ownerSignedFromNormalSide(type, t.opening) ?? t.opening)}") &&
    accountCategoryView.includes("{formatSignedAmount(ownerSignedFromNormalSide(type, t.movement) ?? \"0\")})"),
  "per-currency totals card shows opening/movement/close labels owner-signed via ownerSignedFromNormalSide"
);
ok(
  journalTab.includes("matchesSearch") &&
    journalTab.includes("filteredEntries") &&
    journalTab.includes('placeholder="ค้นหารายการ — ชื่อหุ้น, บัญชี, หมายเหตุ, เลขที่"') &&
    journalTab.includes("พบ {filteredEntries.length} จาก {entries.length} รายการ") &&
    journalTab.includes("ไม่พบรายการที่ค้นหา") &&
    journalTab.includes("filteredEntries.map((entry) => {"),
  "JournalTab (old GL tab) has the same text search as JournalPage (parity)"
);
ok(
  accountLedgerDetail.includes("filteredLines") &&
    accountLedgerDetail.includes('placeholder="ค้นหารายการ เลขที่ หรือ memo…"') &&
    accountLedgerDetail.includes("พบ {filteredLines.length} จาก {lines.length} รายการ") &&
    accountLedgerDetail.includes("ไม่พบรายการที่ค้นหา") &&
    accountLedgerDetail.includes("{filteredLines.map((l) => ("),
  "AccountLedgerDetail filters description/entryNo/memo client-side (running balance untouched)"
);
ok(
  adminDashboard.includes("auditSearch") &&
    adminDashboard.includes("filteredUploadLog") &&
    adminDashboard.includes("filteredAccessLog") &&
    adminDashboard.includes('placeholder="ค้นหาชื่อไฟล์ ผู้ใช้ หรือกิจกรรม"') &&
    adminDashboard.includes("พบ {filteredUploadLog.length + filteredAccessLog.length} รายการ"),
  "Admin audit tab has one search box filtering both uploads + access logs client-side"
);
// ---------------------------------------------------------------------------
// Monthly closing (งบปิดเดือน): pure engine + service + route + tab wiring.
// The report is AS-OF book closing — from/to only pick which months are SHOWN,
// every month's opening is recomputed from the stored opening balance plus the
// full prior history, so the figures never depend on the requested window.
// ---------------------------------------------------------------------------
ok(
  routesFile.includes("api/v1/reports/monthly-closing"),
  "monthly-closing report route is registered next to the other reports"
);
{
  const route = monthlyClosingRoute;
  ok(
    route.includes("getMonthlyClosing") &&
      route.includes("seedDefaultChartOfAccounts") &&
      route.includes("isValidIsoDate") &&
      route.includes('from/to must be ISO dates (yyyy-mm-dd)') &&
      route.includes('status: 405') &&
      route.includes("Method not allowed"),
    "monthly-closing route seeds CoA, validates ISO dates and is GET-only (405)"
  );
}
ok(
  generalLedger.includes("export function buildMonthlyClosing") &&
    generalLedger.includes("MonthlyClosingMonthResult") &&
    generalLedger.includes("MonthlyClosingContinuityIssue") &&
    generalLedger.includes("monthStart") &&
    generalLedger.includes("monthEnd") &&
    generalLedger.includes("betweenMonths") &&
    generalLedger.includes("summarizeAccountLedgers(accounts, linesUpToEnd, start)") &&
    generalLedger.includes("continuity"),
  "pure engine exports buildMonthlyClosing + month helpers + continuity"
);
ok(
  ledgerService.includes("export async function getMonthlyClosing(") &&
    ledgerService.includes("buildMonthlyClosing(accounts, lines, from, to)") &&
    ledgerService.includes("fetchRawLines(userId, undefined, undefined)") &&
    ledgerService.includes("MonthlyClosingLineInput"),
  "ledger-service getMonthlyClosing loads the full POSTED history + accounts in parallel"
);
ok(
  serverApi.includes("fetchMonthlyClosing") &&
    serverApi.includes("GeneralLedgerMonthlyClosing") &&
    serverApi.includes("/api/v1/reports/monthly-closing") &&
    serverApi.includes("import(\"./general-ledger\").MonthlyClosingMonthResult"),
  "server-api client has the monthly-closing fetch + DTO types"
);
ok(
  generalLedgerPage.includes('{ id: "monthly", label: "งบปิดเดือน" }') &&
    generalLedgerPage.includes("<MonthlyClosingTab />"),
  "GL page gains the งบปิดเดือน tab wired to MonthlyClosingTab"
);
ok(
  monthlyClosingTab.includes("fetchMonthlyClosing") &&
    monthlyClosingTab.includes("thaiMonthLabel(") &&
    monthlyClosingTab.includes("THAI_MONTHS") &&
    monthlyClosingTab.includes("report.continuity") &&
    monthlyClosingTab.includes("report.months.map((m) => {") &&
    monthlyClosingTab.includes("setSelectedMonth(open ? null : m.month)"),
  "MonthlyClosingTab fetches the report, renders per-month rows with expandable account detail"
);
ok(
  monthlyClosingTab.includes("ยอดเปิด") &&
    monthlyClosingTab.includes("ยอดปิด") &&
    monthlyClosingTab.includes("เคลื่อนไหว") &&
    monthlyClosingTab.includes("เดบิต") &&
    monthlyClosingTab.includes("เครดิต") &&
    monthlyClosingTab.includes("ความต่อเนื่อง") &&
    monthlyClosingTab.includes("ต่อเนื่อง") &&
    monthlyClosingTab.includes("ยอดเปิดของเดือนถัดไป = ยอดปิดของเดือนก่อนหน้า"),
  "MonthlyClosingTab shows opening/movement/closing, balance badges and a continuity panel"
);
ok(
  monthlyClosingTab.includes("formatSignedAmount(r.opening)") &&
    monthlyClosingTab.includes("formatSignedAmount(r.netMovement)") &&
    monthlyClosingTab.includes("formatSignedAmount(r.closing)") &&
    !monthlyClosingTab.includes("toFixed("),
  "MonthlyClosingTab renders server fields verbatim (debit-positive signs, no recompute in React)"
);

// ---------------------------------------------------------------------------
// Report routes reject impossible calendar dates (2026-02-30) and reversed
// from>to ranges with the same strict validator as the batch account summary.
// ---------------------------------------------------------------------------
for (const [label, route] of [
  ["trial-balance", trialBalanceRoute],
  ["income-statement", incomeStatementRoute],
  ["monthly-closing", monthlyClosingRoute],
] as const) {
  ok(
    route.includes("new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value") &&
      route.includes("from && to && from > to"),
    `${label} route strictly validates ISO dates and rejects reversed from>to ranges`
  );
}
ok(
  balanceSheetRoute.includes("new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value"),
  "balance-sheet route strictly validates the as-of date"
);

// ---------------------------------------------------------------------------
// FX variance leg (5020 THB) + skipped-FX reconcile.
// A confirmed exchange whose statement FX gives the two cash legs slightly
// different THB reporting bases posts a THB variance leg for the exact
// difference; legacy SKIPPED FX rows can be replayed deterministically.
// ---------------------------------------------------------------------------
ok(
  postingEngine.includes('const FX_VARIANCE = "5020"') &&
    postingEngine.includes('FX_VARIANCE_MEMO = "FX conversion variance"'),
  "posting-engine defines the 5020 FX-variance account code and human memo"
);
ok(
  postingEngine.includes("const variance = new Decimal(receivedThb).minus(sentThb)") &&
    postingEngine.includes("...(variance.gt(0)") &&
    postingEngine.includes("variance.abs().toFixed(2)"),
  "posting-engine computes the exact THB difference through moneyInThb and only adds a THB 5020 leg when nonzero"
);
ok(
  (() => {
    const fxBranch = postingEngine.indexOf("const variance = new Decimal(receivedThb).minus(sentThb)");
    const at = postingEngine.indexOf("accountId: FX_VARIANCE,", fxBranch);
    return (
      at !== -1 &&
      postingEngine.slice(at, at + 120).includes('currency: "THB"') &&
      postingEngine.slice(at, at + 160).includes('memo: FX_VARIANCE_MEMO')
    );
  })(),
  "posting-engine stamps the variance leg THB-currency with the human memo"
);
ok(
  postingEngine.includes('import { moneyInThb, roundMoney } from "./accounting-amounts"'),
  "posting-engine derives both THB bases with the shared accounting-amounts helpers"
);
ok(
  generalLedger.includes("varianceLines.length === 1") &&
    generalLedger.includes('v.currency !== "THB"') &&
    generalLedger.includes("roundMoney(diff.abs())") &&
    generalLedger.includes("exactly two cash legs and at most one THB variance line"),
  "validator enforces the 3-leg FX shape (received/sent by currency+amount, exact THB variance)"
);
ok(
  ledgerService.includes("const isVarianceLeg =") &&
    ledgerService.includes("account.code === \"5020\"") &&
    ledgerService.includes("currency exchange allows at most one 5020 THB FX-variance leg"),
  "resolveEntryAccountIds admits the 5020 THB variance leg with an at-most-one guard"
);
ok(
  ledgerService.includes("const dryRun = opts.apply !== true") &&
    ledgerService.includes("A dry run must make ZERO database writes: never seed the chart of accounts") &&
    ledgerService.includes("if (!dryRun)") &&
    ledgerService.includes('(row.type ?? "").trim() === "FX_CONVERSION"') &&
    ledgerService.includes("promotes in per-entry transactions, preserving the existing") &&
    ledgerService.includes("journal entry id/entry_no and source links. Idempotent: a second apply") &&
    ledgerService.includes("promotes 0."),
  "reconcileSkippedFxPostings is dry-run-by-default, zero-write when dry, FX-only and idempotent"
);
ok(
  fxReconcileScript.includes("DEFAULT IS A DRY RUN: zero database writes. Pass --apply to actually promote.") &&
    fxReconcileScript.includes("DRY RUN (no writes)") &&
    fxReconcileScript.includes("process.exit(0)"),
  "reconcile-fx-postings.mts is a dry-run-first CLI (--apply to write) and exits cleanly"
);
ok(
  ledgerService.includes("ilike(journalEntries.skipReason, \"%THB does not balance%\")") &&
    ledgerService.includes('(row.type ?? "").trim() === "FX_CONVERSION"') &&
    ledgerService.includes("belong exclusively to reconcileSkippedFxPostings") &&
    ledgerService.includes("result.promotable += 1") &&
    ledgerService.includes("Promote: replace the SKIPPED record with the same header + REAL lines"),
  "reconcileSkippedRoundingPostings scopes to STATEMENT SKIPPED THB-imbalance rows, excludes FX rows, and promotes the SAME journal entry"
);
ok(
  ledgerService.includes("THB rounding adjustment") &&
    ledgerService.includes('l.currency === "THB" && !cashIds.has(l.accountId) && l.memo === ROUNDING_ADJUSTMENT_MEMO') &&
    ledgerService.includes("Decimal.sum(") &&
    ledgerService.includes("debitThb") &&
    ledgerService.includes("creditThb"),
  "reconcileSkippedRoundingPostings finds the THB 5020 adjustment leg and derives balanced THB totals from the validated entry"
);
ok(
  roundingReconcileScript.includes("DEFAULT IS A DRY RUN: zero database writes. Pass --apply to actually promote.") &&
    roundingReconcileScript.includes("DRY RUN (no writes)") &&
    roundingReconcileScript.includes("process.exit(0)"),
  "reconcile-rounding-postings.mts is a dry-run-first CLI (--apply to write) and exits cleanly"
);
ok(
  ledgerService.includes("const dryRun = opts.apply !== true") &&
    ledgerService.includes("if (dryRun) continue") &&
    ledgerService.includes("result.promotable += 1") &&
    ledgerService.includes("Dry run: report what WOULD be promoted; zero database writes."),
  "reconcileSkippedEquityPostings is dry-run-by-default, counts promotable, and gates promotion behind --apply"
);
ok(
  equityReconcileScript.includes("[--apply]") &&
    equityReconcileScript.includes("DRY RUN BY DEFAULT: without --apply it only reports what WOULD be promoted") &&
    equityReconcileScript.includes("promotable") &&
    equityReconcileScript.includes("process.exit(0)"),
  "reconcile-thb-equity-postings.mts is a dry-run-first CLI (--apply to write) and exits cleanly"
);

// ---------------------------------------------------------------------------
// THB rounding-adjustment leg (auto) + owner-sign presentation.
// A <= 0.01 reporting-base difference on an otherwise-valid single-currency
// non-THB entry posts with an extra THB 5020 leg instead of SKIPPING; the
// owner-sign helpers flip debit-positive/normal-side balances for display.
// ---------------------------------------------------------------------------
ok(
  postingEngine.includes("export function applyThbRoundingAdjustment(") &&
    postingEngine.includes("const entry = applyThbRoundingAdjustment(result.entry)") &&
    postingEngine.includes("if (diff.isZero() || diff.abs().gt(new Decimal(\"0.01\"))) return entry") &&
    postingEngine.includes("ROUNDING_ADJUSTMENT_MEMO"),
  "posting-engine: postCapitalRow appends a THB rounding-adjustment leg only for a <= 0.01 single-currency non-THB difference"
);
ok(
  generalLedger.includes('export const ROUNDING_ADJUSTMENT_MEMO = "THB rounding adjustment"') &&
    generalLedger.includes("THB rounding adjustment allows at most one line") &&
    generalLedger.includes("THB rounding adjustment is not needed: reporting base already balances") &&
    generalLedger.includes("must not hide a reporting-base difference larger than 0.01") &&
    generalLedger.includes("must be THB with amount and side exactly equal to the reporting-base difference"),
  "validator: THB rounding-adjustment branch enforces exactly one THB leg of the exact <= 0.01 difference"
);
ok(
  serverApi.includes("export function ownerSignedFromDebitPositive(") &&
    serverApi.includes('const negate = type === "EQUITY" || type === "INCOME" || type === "EXPENSE"') &&
    serverApi.includes("export function ownerSignedFromNormalSide(") &&
    serverApi.includes('const negate = type === "LIABILITY" || type === "EXPENSE"'),
  "server-api: owner-sign helpers re-sign debit-positive (negate EQUITY/INCOME/EXPENSE) and normal-side (negate LIABILITY/EXPENSE)"
);
ok(
  accountCategoryView.includes('ownerSignedFromDebitPositive(') &&
    accountCategoryView.includes('l.side === "DEBIT" ? l.amount : `-${l.amount}`') &&
    accountCategoryView.includes("ownerSignedFromNormalSide(row.type, s.netMovement)") &&
    accountCategoryView.includes("ownerSignedFromNormalSide(type, t.closing)") &&
    accountCategoryView.includes("แสดงตามหลักเครื่องหมายเจ้าของ") &&
    accountCategoryView.includes("(แค่กลับเครื่องหมายเพื่อให้อ่านง่าย)"),
  "AccountCategoryView: account table + category totals use ownerSignedFromNormalSide; detail movement/running/footer use ownerSignedFromDebitPositive; footnote rewritten"
);
ok(
  overviewTab.includes('? `-${summary.totalsThb.liabilities}`') &&
    overviewTab.includes('? `-${t.liabilities}`') &&
    overviewTab.includes('? `-${t.liabilitiesThb}`') &&
    overviewTab.includes("เครื่องหมายเจ้าของ") &&
    overviewTab.includes("ไม่คำนวณใหม่"),
  "OverviewTab: liability totals render negative (owner sign) via explicit - prefix, server-sourced footnote"
);
ok(
  dashboardPage.includes('? `-${summary.totalsThb.liabilities}`') &&
    dashboardPage.includes('? `-${t.liabilities}`') &&
    dashboardPage.includes('? `-${t.liabilitiesThb}`') &&
    dashboardPage.includes("เครื่องหมายเจ้าของ"),
  "DashboardHomePage: liability totals render negative (owner sign) via explicit - prefix, server-sourced footnote"
);

// ---------------------------------------------------------------------------
// STAX FINAL PROFESSOR-REQUIREMENT PASS:
// 1. Journal status semantics: POSTED / REFERENCE-ONLY / UNPOSTED
// 2. Remove misleading "ข้ามไม่ลงบัญชี" wording
// 3. 5-card responsive summary (รายการทั้งหมด / ลงบัญชีแล้ว / บันทึกอ้างอิง / ยังไม่มีคู่บัญชี / กลับรายการแล้ว)
// 4. Filter label: บันทึกแล้ว (ไม่มีคู่เดบิต/เครดิต) with value="SKIPPED"
// 5. Search includes skipReason
// 6. Detailed auditability
// ---------------------------------------------------------------------------
ok(
  journalPage.includes("บันทึกแล้ว (รายการอ้างอิง)") &&
    journalTab.includes("บันทึกแล้ว (รายการอ้างอิง)"),
  "Journal renders: 'บันทึกแล้ว (รายการอ้างอิง)'"
);
ok(
  journalPage.includes("บันทึกแล้ว (ยังไม่มีคู่บัญชี)") &&
    journalTab.includes("บันทึกแล้ว (ยังไม่มีคู่บัญชี)"),
  "Journal renders: 'บันทึกแล้ว (ยังไม่มีคู่บัญชี)'"
);
ok(
  isReferenceOnlySkip("monthly fee/VAT summary row - fees already inside the BUY acquisition cost / SELL net proceeds") === true &&
    isReferenceOnlySkip("Monthly Fee/VAT aggregate") === true &&
    isReferenceOnlySkip("fee/vat summary") === true,
  "monthly fee/VAT summary is classified reference-only"
);
ok(
  isReferenceOnlySkip("realized gain/loss already posted via the SELL row") === true &&
    isReferenceOnlySkip("already posted via the sell row") === true,
  "realized gain/loss duplicate summary is classified reference-only"
);
ok(
  isReferenceOnlySkip("SELL without trustworthy cost basis / realized gain - NON_COMPUTABLE, not posted") === false,
  "real NON_COMPUTABLE SELL is NOT classified reference-only"
);
ok(
  !journalPage.includes("ข้ามไม่ลงบัญชี") &&
    !journalTab.includes("ข้ามไม่ลงบัญชี") &&
    !journalPage.includes("ข้าม (ไม่ลงบัญชี)"),
  "old visible reference badge 'ข้ามไม่ลงบัญชี' is gone"
);
ok(
  journalPage.includes("summary.reference") &&
    journalPage.includes("summary.unposted") &&
    journalPage.includes("grid-cols-2 sm:grid-cols-3 lg:grid-cols-5") &&
    journalPage.includes("บันทึกอ้างอิง") &&
    journalPage.includes("ยังไม่มีคู่บัญชี"),
  "reference entries are separated from unposted entries in counters"
);
ok(
  journalPage.includes('entry.skipReason ?? ""') &&
    journalTab.includes('entry.skipReason ?? ""'),
  "search includes skipReason"
);
ok(
  journalPage.includes('<option value="SKIPPED">บันทึกแล้ว (ไม่มีคู่เดบิต/เครดิต)</option>') &&
    journalPage.includes("ทุกรายการใน Statement ถูกบันทึกครบถ้วน (รวมถึงรายการอ้างอิงที่ไม่ลงเดบิต/เครดิตซ้ำ)") &&
    journalTab.includes("ทุกรายการใน Statement ถูกบันทึกครบถ้วน (รวมถึงรายการอ้างอิงที่ไม่ลงเดบิต/เครดิตซ้ำ)"),
  "Journal UI presents SKIPPED filter label without 'ข้าม' and updates header copy"
);
ok(
  journalPage.includes("บันทึกครบแล้ว: ผลกระทบทางบัญชีถูกบันทึกผ่านรายการหลักแล้ว จึงไม่ลงเดบิต/เครดิตซ้ำ") &&
    journalTab.includes("บันทึกครบแล้ว: ผลกระทบทางบัญชีถูกบันทึกผ่านรายการหลักแล้ว จึงไม่ลงเดบิต/เครดิตซ้ำ") &&
    journalPage.includes("บันทึกในสมุดรายวันแล้ว:") &&
    journalTab.includes("บันทึกในสมุดรายวันแล้ว:"),
  "Journal renders the required reference and unposted explanation texts"
);

console.log("\n================ SUMMARY ================");
console.log(`PASS: ${passed}   FAIL: ${failed}`);
if (failed > 0) {
  console.log("Failures:\n - " + failures.join("\n - "));
  process.exitCode = 1;
} else {
  console.log("All UI placeholder/wiring checks passed.");
}
