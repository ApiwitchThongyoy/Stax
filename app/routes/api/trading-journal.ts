import { and, desc, eq, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "~/lib/drizzle-db";
import { costBasisState, stockPrices } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import {
  listCapitalLedgerRows,
} from "~/lib/journal-ledger-read";
import {
  buildBehaviorStats,
  buildTradingJournalEntries,
  classifyJournalSide,
  dividendSymbolFor,
  isTradeJournalRow,
  type JournalSide,
} from "~/lib/trading-journal-engine";

function isAuthError(
  result: unknown
): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

const VALID_SIDES: JournalSide[] = ["BUY", "SELL", "DIVIDEND"];

/**
 * GET /api/v1/trading-journal
 *
 * สมุดบันทึกการซื้อขายหุ้นประจำวัน (owner-scoped, read-only).
 *
 * Entries: stock trades ONLY — BUY/SELL trade rows + dividend income rows
 * from the user's journal, oldest-first, each with its replayed
 * avgCostAtTime (the position's own average cost BEFORE the trade landed —
 * server-computed through the Webull average-cost engine over the full
 * lifetime history, so from/to filters never rewrite the average; dividend
 * rows carry null). Interest, capital-gain summary lines, fees/VAT,
 * deposits, FX transfers and GL-manual lines never enter this view (they
 * stay available on the เงินเข้า-ออก / exchange / journal pages).
 *
 * Holdings: per-symbol portfolio summary ONLY for symbols the caller still
 * holds (a position sold in full drops out of cost_basis_state, so it has no
 * card — its trades stay in the journal table and the per-stock detail
 * screen for the full history) — qty/avgCost from cost_basis_state, latest
 * daily close from stock_prices (null when absent), server-computed
 * marketValue/unrealizedPnl/realizedPnl (realized = computable SELL gains +
 * dividend income on the symbol).
 *
 * totals.pnlSummary: period P&L from the filtered entries — realized SELL
 * gains, dividend income, as-of unrealized, and their combined
 * total; non-computable SELLs are counted but never valued.
 *
 * Query params (all optional): from=YYYY-MM-DD, to=YYYY-MM-DD,
 * symbol=NVDA (uppercase), side=BUY|SELL|DIVIDEND.
 *
 * Invalid query values → 400. Read-only; action → 405. P&L is computed
 * server-side; the frontend renders all numbers verbatim.
 */
export async function action() {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

export async function loader({ request }: { request: Request }) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const url = new URL(request.url);
  const from = (url.searchParams.get("from") ?? "").trim();
  const to = (url.searchParams.get("to") ?? "").trim();
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  const sideRaw = (url.searchParams.get("side") ?? "").trim().toUpperCase();
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return Response.json(
      { success: false, message: "Invalid date (expected YYYY-MM-DD)" },
      { status: 400 }
    );
  }
  let sideFilter: JournalSide | null = null;
  if (sideRaw) {
    if (!(VALID_SIDES as string[]).includes(sideRaw)) {
      return Response.json(
        { success: false, message: "Invalid side" },
        { status: 400 }
      );
    }
    sideFilter = sideRaw as JournalSide;
  }

  let journalRows;
  try {
    journalRows = await listCapitalLedgerRows(auth.userId);
  } catch (error) {
    console.error("TradingJournal GET: failed to query journal", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  // Journal-as-SSOT rows, oldest-first, limited to stock trades only:
  // BUY/SELL trade rows + dividend income rows. Interest, capital-gain summary
  // lines, fees/VAT, equity deposits/withdrawals, FX transfers and GL-manual
  // lines are NOT trading activity and stay excluded.
  //
  // `tradeRows` always carries the FULL lifetime history: the per-row
  // avgCostAtTime snapshot is replayed from it, so every entry reports the
  // position's own lifetime average. Narrowing the table to a date window
  // must never rewrite (or erase) the averages that window lands in.
  const tradeRows = journalRows.filter((r) =>
    isTradeJournalRow(r.side, r.category, r.section)
  );
  const fullEntries = buildTradingJournalEntries(tradeRows);

  const entrySymbolOf = (e: (typeof fullEntries)[number]) =>
    (e.symbol ?? "").trim().toUpperCase();

  // Date/symbol narrowing applies to the BUILT entries (replayed snapshots
  // stay pinned to the full-history numbers). `scopedEntries` keeps the
  // date/symbol scope but ignores the side filter, so the summary numbers
  // (P&L, realized) always describe the whole period — filtering to "BUY
  // only" must not zero out the win rate or the per-symbol realized P&L.
  // `entries` is the side-filtered view the table renders.
  let scopedEntries = fullEntries;
  if (from) scopedEntries = scopedEntries.filter((e) => e.date >= from);
  if (to) scopedEntries = scopedEntries.filter((e) => e.date <= to);
  if (symbol)
    scopedEntries = scopedEntries.filter(
      (e) => entrySymbolOf(e) === symbol
    );
  const entries = sideFilter
    ? scopedEntries.filter((e) => e.side === sideFilter)
    : scopedEntries;

  // The same date/symbol scope over the raw journal rows feeds the
  // portfolio-level behavior statistics (which replay the rows themselves).
  const rowSymbolOf = (r: (typeof tradeRows)[number]) => {
    const rowSide = classifyJournalSide(r.side, r.category, r.section);
    const rowSymbol =
      rowSide === "DIVIDEND"
        ? dividendSymbolFor(r.symbol, r.section)
        : r.symbol;
    return (rowSymbol ?? "").trim().toUpperCase();
  };
  let scopeRows = tradeRows;
  if (from) scopeRows = scopeRows.filter((r) => r.entryDate >= from);
  if (to) scopeRows = scopeRows.filter((r) => r.entryDate <= to);
  if (symbol)
    scopeRows = scopeRows.filter((r) => rowSymbolOf(r) === symbol);

  // ---- Per-stock summary (holdings + price + P&L) ----
  const symbolsInScope = new Set(
    entries
      .map((e) => (e.symbol ?? "").trim().toUpperCase())
      .filter((s) => s !== "")
  );

  let holdingRows: Array<{
    symbol: string;
    quantity: string;
    avgCost: string;
    cumQuantity: string;
    cumCost: string;
    updatedAt: string | null;
  }>;
  try {
    holdingRows =
      symbolsInScope.size > 0
        ? await db
            .select({
              symbol: costBasisState.symbol,
              quantity: costBasisState.quantity,
              avgCost: costBasisState.avgCost,
              cumQuantity: costBasisState.cumQuantity,
              cumCost: costBasisState.cumCost,
              updatedAt: costBasisState.updatedAt,
            })
            .from(costBasisState)
            .where(
              and(
                eq(costBasisState.userId, auth.userId),
                inArray(costBasisState.symbol, [...symbolsInScope])
              )
            )
            .execute()
        : [];
  } catch (error) {
    console.error("TradingJournal GET: failed to query cost basis", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
  const holdingBySymbol = new Map(holdingRows.map((h) => [h.symbol, h]));

  let quoteBySymbol = new Map<
    string,
    { priceDate: string | null; close: string | null; currency: string | null }
  >();
  try {
    if (symbolsInScope.size > 0) {
      const quoteRows = await db
        .select({
          symbol: stockPrices.symbol,
          priceDate: stockPrices.priceDate,
          closePrice: stockPrices.closePrice,
          currency: stockPrices.currency,
        })
        .from(stockPrices)
        .where(inArray(stockPrices.symbol, [...symbolsInScope]))
        .orderBy(desc(stockPrices.priceDate))
        .execute();
      for (const q of quoteRows) {
        if (!quoteBySymbol.has(q.symbol)) {
          quoteBySymbol.set(q.symbol, {
            priceDate: q.priceDate,
            close: q.closePrice,
            currency: q.currency,
          });
        }
      }
    }
  } catch {
    // stock_prices is an optional deployment table — degrade to null quotes.
    quoteBySymbol = new Map();
  }

  // Realized gain/income per symbol (THB): the caller's OWN computable SELL
  // rows plus DIVIDEND income received on that symbol (both stored in THB on
  // the row). SELL rows with no computable basis stay out — never invented.
  const realizedBySymbol = new Map<string, Decimal>();
  const addRealized = (symbol: string, raw: string | null | undefined) => {
    if (raw === null || raw === undefined || raw.trim() === "") return;
    try {
      const v = new Decimal(raw);
      if (!v.isFinite()) return;
      const key = symbol.trim().toUpperCase();
      realizedBySymbol.set(
        key,
        (realizedBySymbol.get(key) ?? new Decimal(0)).plus(v)
      );
    } catch {
      // ignore malformed stored values
    }
  };
  for (const e of scopedEntries) {
    if (!e.symbol) continue;
    if (e.side === "SELL") {
      const src = tradeRows.find(
        (r) => r.sourceTransactionId === e.transactionId
      );
      addRealized(e.symbol, src?.realizedGainLossThb ?? null);
    } else if (e.side === "DIVIDEND") {
      addRealized(e.symbol, e.amountThb);
    }
  }

  // Only symbols the caller still holds get a card: a position sold in full
  // has no cost_basis_state row, so its "current" fields are not missing
  // data — the stock simply left the portfolio. The line below keeps every
  // such symbol OUT of the summary while its trades stay in the journal
  // table (and the per-stock detail screen) for the full history.
  const holdings = [...symbolsInScope]
    .filter((sym) => holdingBySymbol.has(sym))
    .sort()
    .map((sym) => {
    const h = holdingBySymbol.get(sym) ?? null;
    const q = quoteBySymbol.get(sym) ?? null;
    const qty = h ? new Decimal(h.quantity) : null;
    const avg = h ? new Decimal(h.avgCost) : null;
    const totalCost =
      qty && avg && qty.isFinite() && avg.isFinite() ? qty.times(avg) : null;
    let close: Decimal | null = null;
    try {
      if (q && q.close && q.close.trim() !== "") {
        const c = new Decimal(q.close);
        if (c.isFinite()) close = c;
      }
    } catch {
      close = null;
    }
    const marketValue = qty && close ? qty.times(close) : null;
    const unrealizedPnl =
      marketValue && totalCost ? marketValue.minus(totalCost) : null;
    const realized = realizedBySymbol.get(sym) ?? null;

    const counts = { buy: 0, sell: 0, dividend: 0, trades: 0 };
    for (const e of entries) {
      if ((e.symbol ?? "").trim().toUpperCase() !== sym) continue;
      counts.trades++;
      if (e.side === "BUY") counts.buy++;
      else if (e.side === "SELL") counts.sell++;
      else if (e.side === "DIVIDEND") counts.dividend++;
    }

    return {
      symbol: sym,
      quantity: h ? h.quantity : null,
      avgCost: h ? h.avgCost : null,
      cumQuantity: h ? h.cumQuantity : null,
      cumCost: h ? h.cumCost : null,
      updatedAt: h ? h.updatedAt : null,
      quotePrice: q?.close ?? null,
      quoteDate: q?.priceDate ?? null,
      quoteCurrency: q?.currency ?? null,
      totalCost: totalCost ? totalCost.toFixed(4) : null,
      marketValue: marketValue ? marketValue.toFixed(4) : null,
      unrealizedPnl: unrealizedPnl ? unrealizedPnl.toFixed(4) : null,
      realizedPnlThb: realized ? realized.toFixed(2) : null,
      tradeCount: counts.trades,
      buyCount: counts.buy,
      sellCount: counts.sell,
      dividendCount: counts.dividend,
    };
  });

  // Totals across the filtered entries.
  let totalFees = new Decimal(0);
  let totalRealizedThb: Decimal | null = null;
  let totalBuyAmount = new Decimal(0);
  let totalSellAmount = new Decimal(0);
  for (const e of entries) {
    if (e.fees) {
      try {
        const f = new Decimal(e.fees);
        if (f.isFinite()) totalFees = totalFees.plus(f);
      } catch {
        // ignore
      }
    }
    const amt = e.netAmount ?? e.amount;
    if (amt) {
      try {
        const v = new Decimal(amt);
        if (v.isFinite()) {
          if (e.side === "BUY") totalBuyAmount = totalBuyAmount.plus(v);
          else if (e.side === "SELL") totalSellAmount = totalSellAmount.plus(v);
        }
      } catch {
        // ignore
      }
    }
  }
  let anyRealized = false;
  for (const v of realizedBySymbol.values()) {
    totalRealizedThb = (totalRealizedThb ?? new Decimal(0)).plus(v);
    anyRealized = true;
  }
  if (!anyRealized) totalRealizedThb = null;

  // ---- Period P&L summary (server-computed from the filtered entries) ----
  // realizedGainThb: computable SELL gains only; dividend income is reported
  // separately (and NEVER invented); unrealizedThb replays the as-of holdings
  // above. Non-computable SELLs are counted, not valued.
  let realizedGainThb = new Decimal(0);
  let hasRealized = false;
  let dividendThb = new Decimal(0);
  let hasDividend = false;
  let computableSellCount = 0;
  let nonComputableSellCount = 0;
  const addThb = (
    raw: string | null | undefined,
    acc: Decimal
  ): { value: Decimal; added: boolean } => {
    if (raw === null || raw === undefined || raw.trim() === "") {
      return { value: acc, added: false };
    }
    try {
      const v = new Decimal(raw);
      if (!v.isFinite()) return { value: acc, added: false };
      return { value: acc.plus(v), added: true };
    } catch {
      return { value: acc, added: false };
    }
  };
  for (const e of scopedEntries) {
    if (e.side === "SELL") {
      const src = tradeRows.find(
        (r) => r.sourceTransactionId === e.transactionId
      );
      const r = addThb(src?.realizedGainLossThb ?? null, realizedGainThb);
      realizedGainThb = r.value;
      if (r.added) {
        hasRealized = true;
        computableSellCount++;
      } else {
        nonComputableSellCount++;
      }
    } else if (e.side === "DIVIDEND") {
      const r = addThb(e.amountThb, dividendThb);
      dividendThb = r.value;
      if (r.added) hasDividend = true;
    }
  }
  let unrealizedThb = new Decimal(0);
  let hasUnrealized = false;
  for (const h of holdings) {
    const r = addThb(h.unrealizedPnl, unrealizedThb);
    unrealizedThb = r.value;
    if (r.added) hasUnrealized = true;
  }
  const combinedThb =
    hasRealized || hasDividend || hasUnrealized
      ? realizedGainThb.plus(dividendThb).plus(unrealizedThb)
      : null;

  // Portfolio-level behavior statistics over the date/symbol scope (never the
  // side filter) — computable SELLs only, server fields, no invention.
  const behavior = buildBehaviorStats(scopeRows);

  return Response.json(
    {
      success: true,
      data: {
        entries,
        holdings,
        totals: {
          tradeCount: entries.length,
          buyCount: entries.filter((e) => e.side === "BUY").length,
          sellCount: entries.filter((e) => e.side === "SELL").length,
          dividendCount: entries.filter((e) => e.side === "DIVIDEND").length,
          totalFees: totalFees.toFixed(2),
          totalBuyAmount: totalBuyAmount.toFixed(2),
          totalSellAmount: totalSellAmount.toFixed(2),
          totalRealizedThb: totalRealizedThb
            ? totalRealizedThb.toFixed(2)
            : null,
          pnlSummary: {
            realizedGainThb: hasRealized ? realizedGainThb.toFixed(2) : null,
            dividendThb: hasDividend ? dividendThb.toFixed(2) : null,
            unrealizedThb: hasUnrealized ? unrealizedThb.toFixed(2) : null,
            combinedThb: combinedThb ? combinedThb.toFixed(2) : null,
            computableSellCount,
            nonComputableSellCount,
          },
          behavior: {
            computableSellCount: behavior.computableSellCount,
            winningSellCount: behavior.winningSellCount,
            losingSellCount: behavior.losingSellCount,
            winRate: behavior.winRate,
            profitFactor: behavior.profitFactor,
            bestTrade: behavior.bestTrade,
            worstTrade: behavior.worstTrade,
            avgHoldingDays: behavior.avgHoldingDays,
          },
        },
      },
    },
    { status: 200 }
  );
}
