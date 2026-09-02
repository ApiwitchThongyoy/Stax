# STAX Project Instructions

## Development Focus

- Current focus is Backend and Database development.
- Do not work ahead of my instructions.
- Only implement tasks that I explicitly request.
- After completing the requested task, stop and wait for my next instruction.

## Existing Frontend

- Preserve the existing Frontend design.
- Do not redesign the UI.
- Do not significantly change existing pages, layouts, components, or styles.
- If Backend integration requires Frontend changes, make only the minimum necessary changes.
- Do not rewrite working Frontend code without a clear reason.

## Existing Project

Before implementing a task:

1. Inspect the relevant existing files.
2. Check the existing project structure and technology stack.
3. Reuse existing libraries and architecture whenever possible.
4. Do not replace frameworks/libraries unless explicitly requested.
5. Do not modify unrelated files.

## Backend and Database

- Implement only the Backend/Database feature currently requested.
- Inspect the existing database schema before changing it.
- Do not create unrelated tables, endpoints, services, or features.
- Never store passwords in plain text.
- Never expose secrets or environment variables.

## Current Known Database Requirement

users:

- ID: UUID
- Email: Unique
- Password_Hash
- Role

## Task Workflow

For each task:

1. Read AGENTS.md.
2. Inspect relevant existing project files.
3. Determine the smallest changes required.
4. Implement only the requested scope.
5. Check for errors.
6. Briefly report which files were changed and what was done.
7. Update Current Status when appropriate.
8. Stop and wait for my next instruction.

## Current Status

Project:
STAX

Current focus:
Backend and Database

Known requirement:
users table with UUID ID, unique Email, Password_Hash, and Role.

Completed:
- Existing project cloned from the current shared repository.
- React Router development skill exists under .agents/skills/react-router/.
- Prisma 7 configured with SQLite (prisma.config.ts, prisma/schema.prisma, .env).
- users table created via migration create_users (prisma/migrations/20260807130407_create_users).
- Prisma Client generated under prisma/generated/prisma.
- documents table created via migration create_documents (prisma/migrations/20260808105847_create_documents). Stores metadata + file_path for uploaded Statement PDFs (no binary in DB). FK documents.user_id -> User.id with index on user_id.
- Server-authoritative frontend wiring done (Drizzle + Postgres/Supabase; Prisma is legacy, not used): added user-scoped `GET /api/v1/documents` (app/routes/api/documents.ts) returning safe metadata; shared `app/lib/server-api.ts` (fetchCapitalLedger / fetchUserDocuments / capitalRowToTransaction / capitalLedgerToTransactions — identity=authoritative transactionId, no fabricated P&L). Dashboard, FxAiPage, Calendar, Statement Archive, and StoredDocumentsList now render from server (ledger + documents API) instead of session-import React state / IndexedDB. Tests: scripts/test-server-api.mts (pure mapping + wiring) added to `npm test`; W2-9 documents user-scoping section added to scripts/run-tests.mts. All tests + typecheck + build pass. Changes NOT committed.
- Server-authoritative Statement download done: `GET /api/v1/documents/:id/download` (app/routes/api/documents.$id.download.ts, registered in app/routes.ts) streams the stored PDF for the authenticated user's OWN document only. Safe 404 on cross-user/missing; file_path resolved strictly inside STATEMENTS_DIR (pure helpers in app/lib/storage/statement-path.ts, DB-free); missing physical file -> safe 404/410 with sanitized server log, no metadata rewrite; Content-Disposition filename sanitized (no header injection); body streamed via Readable.toWeb (not buffered). Frontend StatementArchivePage + StoredDocumentsList download via `downloadUserDocument` (server Blob) — IndexedDB no longer authoritative. Regression coverage: DB-back tests added in scripts/run-tests.mts (DL section, runs only under test:w2 with TEST_DATABASE_URL) + DB-free tests in scripts/test-document-download.mts added to `npm test`. npm test 218 PASS/0 FAIL; typecheck + build pass; git diff --check clean (benign CRLF notice). Changes NOT committed; on branch fix/server-authoritative-statement-download.
- Storage abstraction done (filesystem -> private Supabase Storage ready): new `app/lib/storage/storage-driver.ts` (StatementStorageDriver interface, object keys `statements/<userId>/<documentId>.pdf`, localStorageDriver + supabaseStorageDriver, STORAGE_MODE=supabase|local or auto-detect from SUPABASE_* env vars; tests default to local so they never touch live Supabase). Upload/download/delete now go through getStorageDriver(); statement-storage.ts saveStatementPdf generates documentId before storage and persists the object key in documents.file_path; upload extracts text from in-memory bytes and does best-effort object + DB row cleanup on processing failure; @supabase/supabase-js@2.112.4 installed; .env.example gained SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_STORAGE_BUCKET / STORAGE_MODE placeholders. W2-10 stale test fixed (suspended login + forged-JWT both rejected). DB-backed test:w2 suite now 102 PASS/0 FAIL (adds: upload MIME/magic bytes/size validation, duplicate-upload rejection, register->login->session smoke); npm test 236 PASS/0 FAIL; typecheck + build pass; git diff --check clean. NOT committed; NOT deployed — Vercel preview deploy blocked on human config (vercel CLI login, project link, @react-router/vercel preset or vercel.json, and setting runtime env vars in the dashboard).
- Production audit done: no VITE_* secrets, no dev.db/SQLite runtime deps (Prisma legacy), JWT_SECRET/DATABASE_URL/GEMINI_API_KEY/GEMINI_MODEL server-only, verifyAuth is DB-authoritative (suspended enforced), app routes use relative /api/v1 paths, SSR true without a Vercel preset (deployment adapter decision pending).
- Dashboard financial/tax summary made server-authoritative and honest: fixed the double FX conversion (pnlAmount is already realizedGainLossThb in THB, no `pnlAmount * rate` anywhere); Net Realized P&L card now sums authoritative THB values and only warns ("มีบางรายการที่ยังคำนวณไม่ได้") instead of blanking the whole card when some rows are null; Exchange-rate card derives the ACTUAL rate used — fxRateStatement (Statement) first, external historical provider only as fallback, THB = 1 — with source label and per-transaction caveat, no "BOT API failure" wording; Tax card now calls POST /api/v1/tax/calculate and shows the authoritative tax base ("ฐานภาษีที่คำนวณได้"), labeled as tax base not tax payable, keeps NOT AVAILABLE only when genuinely nothing is computable. Tax Core table reworked on a new server `classification` field: realized-gain / buy-basis / non-computable / not-applicable (CASH/BUY no longer shown as REALIZED_GAIN_LOSS_NOT_COMPUTABLE) and now renders trade detail (symbol, side, qty, price, gross, fees, proceeds, costBasis, realizedGainLoss, fxRateEffective, realizedGainLossThb). Calendar fixed the same double conversion. API DTOs extended (capital-ledgers raw rows + tax/calculate rows) with all trade fields for server-authoritative rendering; no P&L/tax computation in React. Verified live on dev data: 73 rows, Tax Core total ฿140.45 (NVDA SELL computable; 40 BUY=buy-basis, 2 SELL=non-computable, 30 cash=not-applicable). Tests updated (test-server-api +7, test-statement-tax-recon +6, test-ui-placeholders +6). npm test 323 PASS/0 FAIL; test:w2 125 PASS/0 FAIL; typecheck + build clean; git diff --check clean (CRLF notice only). Changes NOT committed.
- Re-import-after-deletion bug FIXED (confirmed root cause: upload step 0 did hash-only duplicate detection via findExistingDocumentByHash and early-returned the duplicate payload BEFORE checking hasSavedDocumentRows; when a user deleted their financial/ledger data — per-row ledger delete or manual DB delete leaves the documents row + stored PDF + content_hash intact — re-uploading the same PDF was rejected as a duplicate and the pipeline never ran, so zero rows were restored; count only). Fixed `app/routes/api/statements/upload.ts`: duplicate decision now checks `hasSavedDocumentRows` — rows present -> duplicate payload (unchanged); no rows -> `rebuildStatementImport` re-extracts+re-parses the uploaded bytes and re-inserts under the EXISTING document id (no new doc/storage object, no duplicate rows), saves cost basis AFTER commit, audits `result:"reimported"`, notifies import; re-parse of 0 rows / extraction failure / unsupported PDF -> stable duplicate payload (keeps W2-10 green). Response adds `rebuilt`, `duplicateDecision` ("duplicate"|"rebuilt"|"fresh"|"unsupported"), `stats` (buyCount/sellCount/cashCount/computableSellCount/statementFxCount/fxRates) — additive, frontend-safe. `app/routes/api/documents.$id.ts` + `app/routes/api/capital-ledgers.$id.ts` now best-effort `rebuildCostBasisStateFromLedger(userId)` after delete (pure replay `recomputeCostBasisMap` mirrors the parser average-cost math: BUY avg=(prevQty*prevAvg+qty*price)/(prevQty+qty), SELL deducts qty with unchanged avg, full drain removes symbol) so cost_basis_state never drifts from the remaining rows. Tests: pure replay/stats tests in scripts/test-statement-tax-recon.mts (+7), DB-backed "REG: RE-IMPORT AFTER LEDGER DELETION" block in scripts/run-tests.mts (minimal pdfjs-legacy-readable PDF builder makePdf; covers import -> dup-reject-with-rows -> simulate deletion -> rebuild under same doc id -> basis re-persist -> statement DELETE reconciles basis), test-ui-placeholders.mts ordering guard re-targeted to the fresh import path. Verified live on dev data (real stored 2026-01.PDF, Supabase DB): after wiping the user's Capital_Transactions + cost_basis_state (document stayed), re-upload returned `rebuilt:true, duplicateDecision:"rebuilt", documentId unchanged 1511e700...`, extracted 69 / saved 59 (36 BUY, 11 SELL, 12 cash, 1 computable SELL, 5 statement FX rates incl. 31.57), ledger back to 59, cost_basis_state re-persisted (BBAI/GLD/GOOG/JEPQ/QQQI remaining positions, drained symbols dropped), single document row (no duplicates). npm test 330 PASS/0 FAIL; test:w2 140 PASS/0 FAIL; typecheck + build clean; git diff --check clean (CRLF notice only). Changes NOT committed.

- Bank-of-Thailand (BOT) dependency REMOVED; FX resolution is now Statement -> Keyless Historical FX Provider -> THB=1. Deleted app/lib/bot-exchange-rate.ts; new app/lib/historical-fx-provider.ts (keyless Frankfurter/ECB provider behind a `HistoricalFxSource` abstraction, `resolveHistoricalFxRate` cache-first via exchange_rate_cache, source label "historical-fx-provider", graceful null on any failure — never throws, never fabricates, no BOT_API_KEY anywhere). `GET /api/v1/exchange-rates` re-pointed to the provider (not-available reason no longer mentions BOT; no-currency mode serves cached rates + THB=1). `app/routes/api/exchange-rates/status.ts` + `app/routes/api/admin/stats.ts` now report `fxProvider` (built_in/always configured) instead of `bot`; Admindashboard row/labels updated. Pipeline gains `applyFxRateFallback` (app/lib/statement-pipeline.ts, pure + injectable, Decimal): applied ONLY to non-THB rows without a statement rate, lands in fx_rate_effective, recomputes amountThb + realizedGainLossThb, never touches fx_rate_statement/fx_rate_bot, provider unavailable/throws -> base fallback kept (import unaffected). `app/routes/api/statements/upload.ts` applies it in BOTH fresh + rebuild paths before insert. UI: Dashboard FX card external label "จาก Historical FX Provider"/"แหล่งที่มา: Historical FX Provider" (was "อ้างอิงจากภายนอก"/"External historical rate"), FxAiPage FX status card renamed (key "fx", zero BOT references), `botRate` state renamed `fxRateEntry`/`fxEntry`, server-api/Financeutils/capital-ledgers/schema comments de-BOT-ified. fx_rate_bot column KEPT as legacy compatibility (manual ledger user-entered rates unchanged; not an FX source). Gemini prompts strengthened (statement-prompt.ts + gemini-statement-parser.ts): exchangeRate/amountThb ONLY if explicitly printed in the document, never guessed/inferred; untouched determinism confirmed (Gemini result is preview-only, never inserted). Tests: run-tests.mts BOT block rewritten as "Historical FX provider (MOCKED)" — asserts BOT_API_KEY no longer required, provider endpoint + source label, 404 -> available:false no invented rate, THB=1 without network, cached rate served with provider down, no BOT endpoint ever contacted; test-statement-tax-recon.mts +9 FX-priority tests (statement 31.57 wins, fallback only when statement absent, THB never overridden, unavailable graceful, no invented P&L, fx_rate_bot untouched); test-ui-placeholders.mts adds Historical FX Provider wording / no-BOT / no-bot-exchange-rate / no-BOT_API_KEY checks. Verified live on dev data: fx rate for 2026-01-30 USD = 31.425 (source historical-fx-provider), THB=1, status returns fxProvider built_in/configured, admin stats 3/3, ledger still 59 rows with NVDA SELL keeping statement FX 31.57. npm test 344 PASS/0 FAIL (was 330); test:w2 146 PASS/0 FAIL (was 140); typecheck + build clean; git diff --check clean (CRLF notice only). Changes NOT committed.

- Final backend audit of feat/complete-backend-systems completed with 3 blocker fixes + 2 cleanups, all rerun-verified:
  - Fix 1 (upload.ts): fresh-import path no longer persists cost_basis_state BEFORE the rows are inserted — `saveCostBasisState` moved AFTER `insertStatementTransactions` (mirrors the rebuild path) and is now best-effort (try/catch, log-only) in BOTH fresh + rebuild paths, so a DB failure mid-import can no longer poison the running-average basis with phantom rows, and a basis-write failure can no longer 500 an already-committed import or push it into the cleanup path that deletes the document row while ledger rows are committed (orphan rows + duplicate-on-reupload risk).
  - Fix 2 (audit-log.ts): `insertAuditLog` is now best-effort/non-throwing (try/catch + console.error) — an audit-write failure can no longer turn a successful login/import/delete into a 500 or trigger error/cleanup paths. Stops the post-commit cleanup window in upload.ts (audit + notification were the only throw-capable steps after the atomic insert).
  - Fix 3 (analysis.ts): repaired the two mojibake Thai error strings (lines 101 + 150, UTF-8 controls) — now proper `ยังไม่มีธุรกรรมที่ต้องการวิเคราะห์` and `การวิเคราะห์ด้วย Gemini ไม่พร้อมใช้งาน`. Also confirmed `data.code` only ever carries stable machine codes (gemini_*), never upstream error text.
  - Fix 4 (CapitalLedgerPage.tsx): editing an imported (AI_PARSED) row no longer crashes — `openEditModal` prefills the rate field from `fx_rate_bot ?? fx_rate_effective ?? fx_rate_statement ?? "1"` (fxRateBot is null for imported rows) and the ApiTransaction type allows `fxRateBot: string | null`, so a simple amount edit can no longer throw on `form.rate.trim()` nor silently reset an imported row's FX to 1.
  - Cleanup: removed 3 debug `console.log("[ACCOUNT_STATUS] ...")` traces from ProtectedLayout.tsx (fired on every protected mount).
  - Audit verified (no defects found): git inventory clean (no .env/dev.db/storage/build/re-act-router tracked); no secrets/VITE_* anywhere; all 24 API routes registered in app/routes.ts and user-scoped; migrations 0007–0010 non-destructive and schema-consistent; gemini parser/analysis never leak keys or statement text and degrade gracefully (429 -> available:false gEMINI_REQUEST_FAILED, confirmed live); parser/pipeline financial math sound (fees signed, proceeds=broker net, realized only on computable SELL, Decimal THB conversion, single conversion no double FX); frontend/backend contract field-for-field (no BOT wording, no P&L/tax computation in React). Left as WARNINGS (not fixed, not blockers): Invoice of a few unused items — notifyAccountStatusChanged (no callers), dailyTaxSummaries table (no consumers), extractTextFromPdf filePath overload (dead), GET /api/v1/documents/:id (no DELETE-paired read), /aggregation/daily + /exchange-rates/status registered but only admin uses status; validateAmount accepts Infinity/whitespace; exchange-rates accepts non-calendar dates/arbitrary currencies (graceful provider null); cost-basis replay uses parseFloat (mirrors parser).
  - Final battery: npm test 344 PASS/0 FAIL; test:w2 146 PASS/0 FAIL; typecheck + build clean; git diff --check clean (CRLF notice only). Live dev smoke (localhost:5173 + dev Supabase): USER/ADMIN login + roles, session, ledger 59 rows, NVDA SELL 2026-01-15 fx 31.57/31.57 with realizedGainLossThb null (honest non-computable), documents=1 + own-download 200 pdf, tax/calculate 59 rows computable=1 totalTaxableAmountThb=107.97 (no double conversion), FX USD 2026-01-30=31.425 source historical-fx-provider, THB=1, USER blocked from admin stats (403), ADMIN stats 3/3 + fxProvider built_in. Changes NOT committed, NOT deployed.

Next:
- Wait for user instruction (pending human steps: Vercel credentials/project link + adapter choice + env vars SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET, DATABASE_URL, JWT_SECRET, GEMINI_API_KEY, GEMINI_MODEL in the Vercel dashboard; then deploy preview; then commit/push/PR).
