import { and, desc, eq } from "drizzle-orm";
import { Decimal } from "decimal.js";
import type { Route } from "./+types/portfolio.$symbol";
import { db } from "~/lib/drizzle-db";
import { costBasisState, stockPrices } from "~/db/schema";
import { verifyAuth, authErrorResponse } from "~/lib/auth-middleware";
import {
  journalEntryToCapitalRow,
  listCapitalLedgerRowsBySymbol,
} from "~/lib/journal-ledger-read";

const SYMBOL_REGEX = /^[A-Z0-9.\-]{1,12}$/;

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

/**
 * GET /api/v1/portfolio/:symbol
 *
 * Per-stock case-by-case view for the logged-in user: every Capital_Transactions
 * row for ONE ticker, the current holding from cost_basis_state, the latest
 * daily close from the (global) stock_prices reference table, and
 * server-authoritative totals — including the sum of REALIZED gain/loss (THB)
 * across computable SELLs. All money numbers are computed server-side; the
 * frontend only renders them verbatim (P&L is never recomputed in React).
 *
 * Ownership is enforced: a user who has no trades AND no holding for the symbol
 * gets a safe 404 (never reveals another user's data). Read-only; action → 405.
 */
export async function action() {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const rawSymbol = params.symbol;
  const symbol = rawSymbol?.trim().toUpperCase() ?? "";
  if (!symbol || !SYMBOL_REGEX.test(symbol)) {
    return Response.json(
      { success: false, message: "Invalid symbol" },
      { status: 400 }
    );
  }

  let trades;
  try {
    // Journal as SSOT: the per-stock ledger rows come from the journal (every
    // Capital_Transactions-mirrored entry, migration 0020), read oldest-first.
    const entries = await listCapitalLedgerRowsBySymbol(auth.userId, symbol);
    trades = entries.map(journalEntryToCapitalRow);
  } catch (error) {
    console.error("Portfolio GET: failed to query transaction journal", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }

  let holdingRows;
  try {
    holdingRows = await db
      .select({
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
          eq(costBasisState.symbol, symbol)
        )
      )
      .limit(1)
      .execute();
  } catch (error) {
    console.error("Portfolio GET: failed to query cost basis", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
  const holdingRow = holdingRows[0] ?? null;

  let quoteRows: Array<{
    priceDate: string | null;
    closePrice: string | null;
    currency: string | null;
    source: string | null;
  }>;
  try {
    quoteRows = await db
      .select({
        priceDate: stockPrices.priceDate,
        closePrice: stockPrices.closePrice,
        currency: stockPrices.currency,
        source: stockPrices.source,
      })
      .from(stockPrices)
      .where(eq(stockPrices.symbol, symbol))
      .orderBy(desc(stockPrices.priceDate))
      .limit(1)
      .execute();
  } catch (error) {
    console.error("Portfolio GET: failed to query stock price", error);
    // The stock_prices reference table is an optional deployment (0017): a schema
    // without it must still serve the trades/holding/totals — the quote degrades
    // to null instead of failing the whole detail (same pattern as the dashboard).
    quoteRows = [];
  }
  const quoteRow = quoteRows[0] ?? null;

  if (trades.length === 0 && !holdingRow) {
    return Response.json(
      { success: false, message: "Stock not found" },
      { status: 404 }
    );
  }

  // ---- Server-authoritative totals (display-only, never recomputed in React) ----
  const buyCount = trades.filter((r) => r.side === "BUY").length;
  const sellCount = trades.filter((r) => r.side === "SELL").length;
  const cashCount = trades.length - buyCount - sellCount;
  const computableSellCount = trades.filter(
    (r) => r.side === "SELL" && r.realizedGainLossThb != null
  ).length;
  const nonComputableSellCount = sellCount - computableSellCount;

  let totalRealizedThb: string | null = null;
  if (computableSellCount > 0) {
    let realized = new Decimal(0);
    for (const r of trades) {
      if (r.side === "SELL" && r.realizedGainLossThb != null) {
        const value = new Decimal(r.realizedGainLossThb);
        if (value.isFinite()) {
          realized = realized.plus(value);
        }
      }
    }
    totalRealizedThb = realized.toFixed(2);
  }

  const quote = quoteRow
    ? {
        priceDate: quoteRow.priceDate,
        close: quoteRow.closePrice,
        currency: quoteRow.currency,
        source: quoteRow.source ?? null,
      }
    : null;

  let holding = null;
  if (holdingRow) {
    const qty = new Decimal(holdingRow.quantity);
    const avg = new Decimal(holdingRow.avgCost);
    const totalCost = qty.times(avg);
    const close =
      quote && quote.close && quote.close.trim() !== ""
        ? new Decimal(quote.close)
        : null;
    const closeFinite = close && close.isFinite() ? close : null;
    const marketValue = closeFinite ? qty.times(closeFinite) : null;
    const unrealizedPnl = marketValue ? marketValue.minus(totalCost) : null;
    holding = {
      quantity: holdingRow.quantity,
      avgCost: holdingRow.avgCost,
      cumQuantity: holdingRow.cumQuantity,
      cumCost: holdingRow.cumCost,
      updatedAt: holdingRow.updatedAt,
      totalCost: totalCost.toFixed(4),
      // Display-only: current price × qty and (price − avgCost) × qty, using the
      // latest stored daily close. Informational marker for the user — NOT a tax
      // or ledger input (same semantics as the Dashboard holdings card).
      marketValue: marketValue ? marketValue.toFixed(4) : null,
      unrealizedPnl: unrealizedPnl ? unrealizedPnl.toFixed(4) : null,
    };
  }

  return Response.json(
    {
      success: true,
      data: {
        symbol,
        trades,
        holding,
        quote,
        totals: {
          tradeCount: trades.length,
          buyCount,
          sellCount,
          cashCount,
          computableSellCount,
          nonComputableSellCount,
          totalRealizedThb,
        },
      },
    },
    { status: 200 }
  );
}