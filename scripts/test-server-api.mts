// Server-authoritative frontend wiring tests (pure, no DB, no browser).
//
// Covers the mapping used to render server Capital_Transactions rows on the
// Dashboard / FX page:
//   - identity is the authoritative transactionId (unique),
//   - duplicate-looking legitimate rows are both preserved (identical
//     date/amount do NOT count as duplicates),
//   - no gain/loss is invented (server rows have no P&L column -> pnlAmount 0),
//   - the dashboard data source is the server ledger, not session state.
// Run:  npx tsx scripts/test-server-api.mts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./_load-env.mjs";
import {
  capitalRowToTransaction,
  capitalLedgerToTransactions,
  type CapitalLedgerRow,
  holdingTotalCost,
  holdingCurrency,
} from "../app/lib/server-api";
import {
  sumAuthoritativeGainThb,
  hasNonComputableGain,
} from "../app/lib/Financeutils";

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

function row(
  transactionId: string,
  date: string,
  amountForeign: string,
  currency: string,
  fxRateBot: string
): CapitalLedgerRow {
  return {
    transactionId,
    userId: "49af10b3-7b8b-4e0b-bd00-22c2d47822b1",
    amountForeign,
    currency,
    transactionDate: date,
    fxRateBot,
    amountThb: String(Number(amountForeign) * Number(fxRateBot)),
    type: "CASH_IN",
    sourceType: "AI_PARSED",
    sourceDocumentId: "b3b598f4-ea24-4b85-be8d-8b93ac5263f3",
  };
}

function main() {
  console.log("\n=== SERVER-AUTHORITATIVE FRONTEND WIRING (mapping) ===\n");

  // The authoritative affected-user set: 13 rows, incl. the two IDENTICAL
  // 2026-01-30 CASH_IN THB 5000.00 rows that are legitimately distinct.
  const ledger: CapitalLedgerRow[] = [
    row("944fd268", "2026-01-01", "0.37", "USD", "35.42"),
    row("5eca420c", "2026-01-16", "158.60", "USD", "35.42"),
    row("683369e1", "2026-01-16", "5000.00", "THB", "1"),
    row("698281b5", "2026-01-27", "160.69", "USD", "35.42"),
    row("f4a29276", "2026-01-27", "5000.00", "THB", "1"),
    row("1669e91c", "2026-01-30", "5000.00", "THB", "1"),
    row("2f9b73dc", "2026-01-30", "5000.00", "THB", "1"),
    row("e5925019", "2026-01-30", "316.91", "USD", "35.42"),
    row("09b2b806", "2026-01-31", "10000.00", "THB", "1"),
    row("6b3d1140", "2026-02-01", "1.78", "USD", "35.42"),
    row("b49d925c", "2026-02-02", "314.16", "USD", "35.42"),
    row("1d42c6d4", "2026-02-24", "5000.00", "THB", "1"),
    row("9c8abef6", "2026-02-24", "161.03", "USD", "35.42"),
  ];

  const txs = capitalLedgerToTransactions(ledger);
  ok(txs.length === 13, "13 server rows map to 13 frontend transactions");
  const ids = txs.map((t) => t.id);
  ok(new Set(ids).size === 13, "all 13 mapped transactions have unique IDs");

  // 1. Duplicate-looking legitimate rows are BOTH preserved (identity = ID).
  const jan30 = txs.filter((t) => t.date === "2026-01-30");
  ok(
    jan30.length === 3 &&
      new Set(jan30.map((t) => t.id)).size === 3,
    "2026-01-30 rows (incl. the two identical 5000.00 THB) are all preserved by ID"
  );
  const dupPair = txs.filter(
    (t) => t.date === "2026-01-30" && t.amount === 5000 && t.currency === "THB"
  );
  ok(
    dupPair.length === 2 && new Set(dupPair.map((t) => t.id)).size === 2,
    "the two identical 2026-01-30 CASH_IN 5000.00 THB rows are both kept (NOT deduped)"
  );

  // 2. Identity mapping preserves transactionId as the UI React key source.
  for (const t of txs) {
    ok(t.id === ledger.find((l) => l.transactionId === t.id)?.transactionId, "id round-trips to server transactionId");
  }

  // 3. No invented P&L: rows without an authoritative realized gain are null,
  //    never a fake 0.
  ok(
    txs.every((t) => t.pnlAmount === null),
    "mapped rows without an authoritative gain expose pnlAmount null (never a fake 0)"
  );

  // 4. Net realized P&L card derives from the server set: pnlAmount is ALREADY
  //    THB (realizedGainLossThb) and is summed WITHOUT re-applying FX (no double
  //    conversion). Null rows contribute 0.
  const gainLoss = sumAuthoritativeGainThb(txs);
  ok(
    gainLoss === 0,
    "dashboard gain/loss from server rows is honest (0, no fabricated P&L)"
  );

  // 4b. A computable SELL row carries realizedGainLossThb; the dashboard card
  //     must sum it in THB directly (NOT pnlAmount * rate).
  const sellRow: CapitalLedgerRow = {
    transactionId: "sell-nvda-001",
    userId: "49af10b3-7b8b-4e0b-bd00-22c2d47822b1",
    amountForeign: "140.43",
    currency: "USD",
    transactionDate: "2026-06-16",
    fxRateBot: "31.57",
    fxRateStatement: "31.57",
    fxRateEffective: "31.57",
    amountThb: "4433.37",
    type: "CASH_IN",
    sourceType: "STATEMENT_TRADE_RECORDS",
    sourceDocumentId: "b3b598f4-ea24-4b85-be8d-8b93ac5263f3",
    realizedGainLossThb: "140.45",
    symbol: "NVDA",
    side: "SELL",
    quantity: "0.0160",
    unitPrice: "140.43",
    grossAmount: "2.25",
    fees: "0.01",
    proceeds: "2.25",
    costBasis: "2.10",
    realizedGainLoss: "0.15",
    exchange: "NASDAQ",
  };
  const sellTx = capitalRowToTransaction(sellRow);
  ok(
    sellTx.pnlAmount === 140.45,
    "computable SELL row maps pnlAmount to authoritative realizedGainLossThb (THB)"
  );
  ok(
    sellTx.sourceDocumentId === "b3b598f4-ea24-4b85-be8d-8b93ac5263f3",
    "sourceDocumentId maps through to the frontend Transaction (Statement-per-day wiring)"
  );
  ok(
    sellTx.symbol === "NVDA" &&
      sellTx.side === "SELL" &&
      sellTx.quantity === "0.0160" &&
      sellTx.unitPrice === "140.43" &&
      sellTx.grossAmount === "2.25" &&
      sellTx.fees === "0.01" &&
      sellTx.proceeds === "2.25" &&
      sellTx.costBasis === "2.10" &&
      sellTx.realizedGainLoss === "0.15" &&
      sellTx.fxRateStatement === "31.57" &&
      sellTx.fxRateEffective === "31.57" &&
      sellTx.exchange === "NASDAQ",
    "trade detail fields (symbol/side/qty/price/gross/fees/proceeds/costBasis/realized/fx/exchange) map through"
  );
  ok(
    sumAuthoritativeGainThb([sellTx]) === 140.45,
    "dashboard net realized card sums pnlAmount in THB directly (no FX re-application)"
  );
  const badAgg = sellTx.pnlAmount === null ? 0 : sellTx.pnlAmount * Number(sellTx.rate);
  ok(
    badAgg !== sumAuthoritativeGainThb([sellTx]),
    "the OLD dot-plot (pnlAmount * rate) would be wrong (double conversion is fixed)"
  );
  const dashSrc = readFileSync(join(process.cwd(), "app/component/DashboardUser/Dashboard.tsx"), "utf8");
  ok(
    !dashSrc.includes("pnlAmount *"),
    "Dashboard screen no longer multiplies pnlAmount by rate (no FX re-application in React)"
  );
  ok(
    !dashSrc.includes("sumAuthoritativeGainThb"),
    "Dashboard screen no longer computes P&L totals in React (the overview moved server-side)"
  );

  // 4c. Partial computability: a mixed set (one computable SELL, one null)
  //     yields a numeric total with a non-computable warning.
  const mixed = [sellTx, capitalRowToTransaction(row("xxx1", "2026-03-01", "5.00", "USD", "35.42"))];
  ok(
    sumAuthoritativeGainThb(mixed) === 140.45 && hasNonComputableGain(mixed),
    "partial computability: numeric total (140.45) + non-computable warning present"
  );

  // 5. Business formula preserved: amount is foreign, rate FX, so amount*rate=THB.
  const usdRow = capitalRowToTransaction(row("x1", "2026-01-05", "1.00", "USD", "35.4200"));
  ok(
    Number(usdRow.amount) === 1 && Number(usdRow.rate) === 35.42 &&
      Number(usdRow.amount) * Number(usdRow.rate) === 35.42,
    "amount=foreign, rate=FX -> amount*rate gives THB (formula unchanged)"
  );

  // 6. Data source wiring: dashboard home fetches the shared server fetchers,
  //     and the Overview tab from its own server endpoints.
  const dash = readFileSync(join(process.cwd(), "app/component/DashboardUser/Dashboard.tsx"), "utf8");
  const overview = readFileSync(join(process.cwd(), "app/component/LedgerRedesign/OverviewTab.tsx"), "utf8");
  ok(
    dash.includes("fetchCapitalLedger") &&
      dash.includes("capitalLedgerToTransactions") &&
      dash.includes("fetchUserDocuments"),
    "Dashboard feeds the home view from the SHARED server fetchers (server-authoritative)"
  );
  ok(
    overview.includes("fetchLedgerSummary") && overview.includes("fetchCostBasis"),
    "Overview tab loads numbers from GET /api/v1/ledger/summary + GET /api/v1/cost-basis (server-authoritative)"
  );
  ok(
    !dash.includes("[...mapped, ...prev]"),
    "Dashboard no longer appends a second independent copy of imported rows"
  );
  ok(
    dash.includes("/api/v1/capital-ledgers") === false ||
      dash.includes("fetchCapitalLedger"),
    "Dashboard uses the shared server ledger fetcher"
  );
  const archive = readFileSync(join(process.cwd(), "app/component/DashboardUser/StatementArchivePage.tsx"), "utf8");
  ok(
    archive.includes("fetchUserDocuments"),
    "Statement Archive list comes from GET /api/v1/documents (server), not IndexedDB"
  );
  ok(
    !archive.includes("listDocuments(user.id)") && !archive.includes("listDocuments(user"),
    "Statement Archive no longer lists from IndexedDB"
  );

  // 7. Download wiring: the frontend must get file bytes from the server
  // endpoint (GET /api/v1/documents/:id/download), NOT IndexedDB as authority.
  const dlBody = (src: string) => {
    const s = src.indexOf("const handleDownload");
    const e = src.indexOf("\n  };", s);
    return s >= 0 && e >= 0 ? src.slice(s, e + 4) : "";
  };
  const archiveSrc = readFileSync(join(process.cwd(), "app/component/DashboardUser/StatementArchivePage.tsx"), "utf8");
  ok(
    archiveSrc.includes("downloadUserDocument"),
    "Statement Archive download uses the server download helper"
  );
  ok(
    archiveSrc.includes("/download") || archiveSrc.includes("downloadUserDocument("),
    "Statement Archive download reaches the :id/download endpoint"
  );
  const archiveDl = dlBody(archiveSrc);
  ok(
    archiveDl.includes("downloadUserDocument") &&
      !archiveDl.includes("getLocalBlobById") &&
      !archiveDl.includes("getLocalDocumentByName"),
    "Statement Archive download handler fetches from server (IndexedDB not authoritative)"
  );
  const listSrc = readFileSync(join(process.cwd(), "app/component/DashboardUser/Storeddocumentslist.tsx"), "utf8");
  ok(
    listSrc.includes("downloadUserDocument"),
    "Stored Documents List download uses the server download helper"
  );
  const listDl = dlBody(listSrc);
  ok(
    listDl.includes("downloadUserDocument") &&
      !listDl.includes("getLocalBlobById") &&
      !listDl.includes("getLocalDocumentByName"),
    "Stored Documents List download handler fetches from server (IndexedDB not authoritative)"
  );

  // ---- holdings display helpers (server fields only, no computed P&L) ----
  ok(
    holdingCurrency("NVDA") === "USD" && holdingCurrency("BBAI") === "USD",
    "holdingCurrency is a display-only label defaulting to USD for US tickers"
  );
  ok(
    holdingTotalCost({
      symbol: "NVDA",
      quantity: "15",
      avgCost: "120.50",
      updatedAt: "2026-01-31T00:00:00.000Z",
    }) === "1807.5",
    "holdingTotalCost = quantity × avgCost (15 × 120.50 = 1807.5)"
  );
  ok(
    holdingTotalCost({
      symbol: "BBAI",
      quantity: "1000",
      avgCost: "3.42",
      updatedAt: "2026-01-31T00:00:00.000Z",
    }) === "3420",
    "holdingTotalCost multiplies server numeric strings for display only"
  );
  ok(
    holdingTotalCost({
      symbol: "X",
      quantity: "abc",
      avgCost: "5",
      updatedAt: "",
    }) === "0",
    "holdingTotalCost returns 0 for non-finite inputs instead of NaN"
  );

  // ---- per-stock detail (case-by-case) client wiring ----
  const serverApiSrc = readFileSync(join(process.cwd(), "app/lib/server-api.ts"), "utf8");
  const routesSrc = readFileSync(join(process.cwd(), "app/routes.ts"), "utf8");
  ok(
    serverApiSrc.includes("export interface PortfolioDetail") &&
      serverApiSrc.includes("export interface PortfolioTotalsDetail") &&
      serverApiSrc.includes("export async function fetchPortfolioDetail"),
    "server-api exposes the per-stock PortfolioDetail DTOs + fetchPortfolioDetail helper"
  );
  ok(
    serverApiSrc.includes("/api/v1/portfolio/${encodeURIComponent(symbol.trim().toUpperCase())}"),
    "fetchPortfolioDetail targets GET /api/v1/portfolio/:symbol (uppercased + encoded)"
  );
  ok(
    serverApiSrc.includes("totalRealizedThb: string | null") &&
      serverApiSrc.includes("unrealizedPnl: string | null") &&
      serverApiSrc.includes("P&L is never recomputed on the client"),
    "PortfolioDetail totals are server-authoritative and explicitly non-recomputed client-side"
  );
  ok(
    routesSrc.includes("api/v1/portfolio/:symbol"),
    "app/routes.ts registers api/v1/portfolio/:symbol"
  );

  // ---- journal-as-SSOT client wiring ----
  ok(
    serverApiSrc.includes("export interface GeneralLedgerJournalTradeDetail") &&
      serverApiSrc.includes('postingState: "POSTED" | "SKIPPED"') &&
      serverApiSrc.includes("skipReason: string | null"),
    "server-api exposes journal DTOs with postingState + skipReason (SKIPPED entries)"
  );
  ok(
    serverApiSrc.includes("fees: string | null") &&
      serverApiSrc.includes("currency: string | null") &&
      serverApiSrc.includes("isFxConversion: boolean"),
    "journal entry/ledger detail DTOs carry fees + currency + isFxConversion flag"
  );
  ok(
    serverApiSrc.includes("export interface JournalEntryFilters") &&
      serverApiSrc.includes("sourceType") &&
      serverApiSrc.includes("postingState"),
    "server-api exposes JournalEntryFilters (sourceType + postingState for fetchJournal)"
  );
  ok(
    serverApiSrc.includes("export async function fetchJournal") &&
      serverApiSrc.includes("/api/v1/journal") &&
      serverApiSrc.includes("journalParams"),
    "fetchJournal targets GET /api/v1/journal and builds params from period + filters"
  );

  console.log(`\n================ SUMMARY ================`);
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main();
