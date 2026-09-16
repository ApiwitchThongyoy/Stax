import { sql } from "drizzle-orm";
import { db } from "./drizzle-db";
import { capitalTransactions } from "../db/schema";
import {
  getLatestStockPrice,
  upsertStockPrice,
} from "./stock-price-cache";
import {
  type StockPriceSource,
  yahooFinanceStockSource,
  isDefaultStale,
  refreshStockPricesCore,
  normalizeStockSymbol,
  isValidStockQuote,
} from "./stock-price-provider";
import { safeErrorLog } from "./safe-error-log";

/**
 * DB-aware service wiring the daily stock-price refresh + read path.
 *
 *  - getTrackedSymbols(): every distinct symbol ever traded across ALL users
 *    (prices are global market data). Fresh symbols appear here as soon as a
 *    statement import stores its first trade row — no separate watchlist table.
 *  - refreshStockPrices(): the daily sweep (Vercel cron / admin / lazy).
 *  - resolveStockPrice(): cache-first read with lazy refresh; a provider
 *    failure falls back to the last-known price (honest), never a fabricated
 *    one.
 */

export interface StockPriceRefreshStats {
  requested: number;
  updated: number;
  failed: string[];
}

/** A resolvable quote sent to the UI (close + provider/cache provenance). */
export interface StockPriceQuoteResult {
  symbol: string;
  priceDate: string;
  close: number;
  currency: string;
  priceUpdatedAt: string;
  source: string;
}

const CACHE_SOURCE_LABEL = "stock-price-cache";

/** Distinct uppercase symbols referenced by the capital-ledger trade rows. */
export async function getTrackedSymbols(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ symbol: capitalTransactions.symbol })
    .from(capitalTransactions)
    .where(sql`${capitalTransactions.symbol} IS NOT NULL`)
    .orderBy(capitalTransactions.symbol)
    .execute();

  return rows
    .map((r) => r.symbol)
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => s.toUpperCase());
}

/**
 * Refresh every tracked symbol's latest close through the provider and persist
 * successes. Bad symbols are reported (never thrown); callers read the stats.
 */
export async function refreshStockPrices(
  symbols?: string[],
  source: StockPriceSource = yahooFinanceStockSource
): Promise<StockPriceRefreshStats> {
  const targets =
    symbols && symbols.length > 0 ? symbols : await getTrackedSymbols();
  const deduped = [...new Set(targets.map((s) => s.trim().toUpperCase()))];

  const core = await refreshStockPricesCore(deduped, source, upsertStockPrice, {
    delayMs: 250,
  });
  return {
    requested: core.requested,
    updated: core.updated,
    failed: core.failed,
  };
}

/**
 * Cache-first resolution of a symbol's current close for display:
 *   1. Fresh stored row (< 1 day old) → served as-is (no network).
 *   2. Stale or missing → one provider lookup; on success the row is upserted
 *      and served.
 *   3. Provider failure → the last-known row is served when one exists (stale
 *      but honest), else null (no price — UI renders "-").
 */
export async function resolveStockPrice(
  symbol: string,
  source: StockPriceSource = yahooFinanceStockSource
): Promise<StockPriceQuoteResult | null> {
  const upper = normalizeStockSymbol(symbol);
  if (!upper) return null;
  const cached = await getLatestStockPrice(upper);
  if (cached && !isDefaultStale(cached.updatedAt)) {
    return quoteResultFromCached(upper, cached);
  }

  try {
    const fresh = await source.getClose(upper);
    if (fresh && isValidStockQuote(fresh)) {
      const wrote = await upsertStockPrice({
        symbol: upper,
        priceDate: fresh.priceDate,
        close: fresh.close,
        currency: fresh.currency,
      });
      return {
        symbol: upper,
        priceDate: wrote.priceDate,
        close: parseFloat(wrote.closePrice),
        currency: wrote.currency,
        priceUpdatedAt: wrote.updatedAt,
        source: YAHOO_FINANCE_SOURCE_NAME_LABEL,
      };
    }
  } catch (error) {
    console.warn("Stock price lookup failed", safeErrorLog(error));
  }

  if (cached) {
    return quoteResultFromCached(upper, cached);
  }
  return null;
}

/** Resolve several symbols at once (each lazily). */
export async function resolveStockQuotes(
  symbols: string[],
  source: StockPriceSource = yahooFinanceStockSource
): Promise<StockPriceQuoteResult[]> {
  const deduped = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const results: StockPriceQuoteResult[] = [];
  for (const symbol of deduped) {
    const quote = await resolveStockPrice(symbol, source);
    if (quote) results.push(quote);
  }
  return results;
}

function quoteResultFromCached(
  symbol: string,
  cached: {
    priceDate: string;
    closePrice: string;
    currency: string;
    updatedAt: string;
  }
): StockPriceQuoteResult {
  return {
    symbol,
    priceDate: cached.priceDate,
    close: parseFloat(cached.closePrice),
    currency: cached.currency,
    priceUpdatedAt: cached.updatedAt,
    source: CACHE_SOURCE_LABEL,
  };
}

const YAHOO_FINANCE_SOURCE_NAME_LABEL = "yahoo-finance";
