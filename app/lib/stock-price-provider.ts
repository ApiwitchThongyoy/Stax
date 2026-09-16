import { randomUUID } from "node:crypto";
import { safeErrorLog } from "./safe-error-log";

/**
 * Daily-close stock price provider (keyless), used to enrich the Dashboard
 * "การถือครองหุ้น" card with the current market price, market value and
 * unrealized gain/loss of the user's open holdings. Follows the same pattern as
 * the historical FX provider: an injectable `StockPriceSource` behind a
 * graceful keyless default (Yahoo Finance chart API, no API key), never
 * fabricating a price when the provider is down.
 *
 * Lookup priority:
 *   A. Cache (`stock_prices` table) — served when the latest row is fresh (the
 *      `updated_at` check in `isDefaultStale`) .
 *   B. Provider lookup — on success the quote is upserted per (symbol,
 *      price_date) so repeated reads never re-hit the network.
 *   C. Nothing — a provider failure yields null (honest "no price"), it never
 *      guesses a number.
 */

/** Canonical source label for the Yahoo Finance stock provider. */
export const YAHOO_FINANCE_SOURCE_NAME = "yahoo-finance";

/** Full quote that the app persists per (symbol, price_date). */
export interface StockQuoteInput {
  symbol: string;
  priceDate: string;
  close: number;
  currency: string;
}

/** Outbound strategy for a single symbol lookup (no auth, no key). */
export interface StockPriceSource {
  name: string;
  /**
   * Resolve the most recent daily close for `symbol`. Returns the quote payload
   * without the symbol (the caller already knows it) or null on any failure.
   */
  getClose(symbol: string): Promise<Omit<StockQuoteInput, "symbol"> | null>;
}

/** Injectable upsert sink used by the DB-free refresh core in tests. */
export interface StockPriceUpsert {
  (quote: StockQuoteInput): Promise<unknown>;
}

const REQUEST_TIMEOUT_MS = 15_000;
const YAHOO_CHART_API_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

/** Milliseconds that make a stored price "stale" (fetch again after ~1 day). */
export const DEFAULT_STALE_MS = 86_400_000;

export function normalizeStockSymbol(symbol: string): string | null {
  const normalized = symbol.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(normalized) ? normalized : null;
}

export function isValidStockQuote(quote: Omit<StockQuoteInput, "symbol">): boolean {
  if (!Number.isFinite(quote.close) || quote.close <= 0 || !/^[A-Z]{3}$/.test(quote.currency)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quote.priceDate)) return false;
  const date = new Date(`${quote.priceDate}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === quote.priceDate;
}

function formatUtcDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Extract the last real (non-null) daily close + its date + currency from a
 * Yahoo Finance `/v8/finance/chart` response body. Pure and defensive:
 * malformed shapes, `chart.error`, missing/empty series or all-null closes
 * return null — never an invented price.
 */
export function parseYahooChartResponse(
  body: unknown,
  now: Date = new Date()
): Omit<StockQuoteInput, "symbol"> | null {
  if (typeof body !== "object" || body === null) return null;
  const chart = (body as { chart?: unknown }).chart;
  if (typeof chart !== "object" || chart === null) return null;
  const chartObj = chart as { error?: unknown; result?: unknown[] };
  if (chartObj.error != null) return null;

  const result = chartObj.result?.[0];
  if (typeof result !== "object" || result === null) return null;
  const res = result as {
    meta?: { currency?: unknown; exchangeTimezoneName?: unknown;
      currentTradingPeriod?: { regular?: { start?: unknown; end?: unknown } } };
    timestamp?: unknown[];
    indicators?: {
      quote?: Array<{ close?: unknown[] }>;
    };
  };

  const currency = res.meta?.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;

  const timestamps = res.timestamp;
  const closes = res.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) return null;
  if (timestamps.length === 0 || timestamps.length !== closes.length) return null;

  for (let i = closes.length - 1; i >= 0; i--) {
    const rawClose = closes[i];
    if (rawClose === null || rawClose === undefined) continue;
    if (typeof rawClose !== "number" || !Number.isFinite(rawClose) || rawClose <= 0) continue;
    const close = rawClose;

    const rawTs = timestamps[i];
    if (typeof rawTs !== "number" || !Number.isFinite(rawTs) || rawTs <= 0) continue;
    const ts = rawTs;
    if (!Number.isFinite(new Date(ts * 1000).getTime()) || ts * 1000 > now.getTime()) continue;
    // Yahoo's final daily bar can still be today's live, unfinished session.
    const regular = res.meta?.currentTradingPeriod?.regular;
    if (typeof regular?.start === "number" && typeof regular.end === "number"
      && ts >= regular.start && now.getTime() < regular.end * 1000) continue;

    let priceDate = formatUtcDate(ts);
    if (typeof res.meta?.exchangeTimezoneName === "string") {
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: res.meta.exchangeTimezoneName, year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(new Date(ts * 1000));
        const value = (type: string) => parts.find((p) => p.type === type)?.value;
        priceDate = `${value("year")}-${value("month")}-${value("day")}`;
      } catch { return null; }
    }

    return {
      priceDate,
      close,
      currency,
    };
  }

  return null;
}

/**
 * Default Yahoo Finance source (keyless). Requests a 5-day daily-close series
 * and returns the most recent real close. Every failure (timeout, non-2xx,
 * bad JSON, unparseable body) is logged and yields null — graceful, never
 * throws, never breaks the caller.
 */
export const yahooFinanceStockSource: StockPriceSource = {
  name: YAHOO_FINANCE_SOURCE_NAME,
  async getClose(symbol: string): Promise<Omit<StockQuoteInput, "symbol"> | null> {
    const normalized = normalizeStockSymbol(symbol);
    if (!normalized) return null;
    symbol = normalized;
    const url = new URL(`${YAHOO_CHART_API_BASE}/${encodeURIComponent(symbol)}`);
    url.searchParams.set("range", "5d");
    url.searchParams.set("interval", "1d");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn(
          `Stock price provider returned status ${response.status} for ${symbol}`
        );
        return null;
      }

      const body: unknown = await response.json();
      const parsed = parseYahooChartResponse(body);
      if (!parsed) {
        console.warn(
          `Stock price provider returned no parseable close for ${symbol}`
        );
        return null;
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.warn(`Stock price provider request timed out for ${symbol}`);
      } else {
        console.warn(
          `Stock price provider network error for ${symbol}:`,
          safeErrorLog(error)
        );
      }
      return null;
    } finally {
      // Covers response body consumption too, and every early/error return.
      clearTimeout(timeout);
    }
  },
};

/**
 * Staleness check for a stored price's `updated_at`: data older than `maxAgeMs`
 * (default 1 day) should be refreshed before being shown. Missing timestamps
 * are treated as stale so the first call always tries the provider.
 */
export function isDefaultStale(
  updatedAtIso: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!updatedAtIso) return true;
  const t = new Date(updatedAtIso).getTime();
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= DEFAULT_STALE_MS;
}

/**
 * DB-free refresh core: walks the requested symbols through a `StockPriceSource`
 * and persists each successful quote via the injected `upsert`. Never throws —
 * provider failures accumulate in `stats.failed` so a single bad ticker can't
 * abort the whole sweep. `delayMs` (default 250) throttles outbound calls to
 * keep the unofficial provider happy.
 */
export async function refreshStockPricesCore(
  symbols: string[],
  source: StockPriceSource,
  upsert: StockPriceUpsert,
  opts?: {
    delayMs?: number;
    now?: Date;
    hintPriceDate?: (symbol: string) => string | null;
  }
): Promise<{ requested: number; updated: number; failed: string[] }> {
  const delayMs = opts?.delayMs ?? 250;
  const failed: string[] = [];
  let updated = 0;

  for (const [index, symbol] of symbols.entries()) {
    if (index > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let updatedThisSymbol = false;
    try {
      const normalized = normalizeStockSymbol(symbol);
      const quote = normalized ? await source.getClose(normalized) : null;
      if (quote && isValidStockQuote(quote)) {
        // Keep the provider's trading date, including weekends/holidays.
        const priceDate = quote.priceDate;
        await upsert({
          symbol: normalized!,
          priceDate,
          close: quote.close,
          currency: quote.currency,
        });
        updated++;
        updatedThisSymbol = true;
      }
    } catch (error) {
      console.warn("Stock price refresh: symbol failed", safeErrorLog(error));
    }
    if (!updatedThisSymbol) {
      failed.push(symbol);
    }
  }

  return { requested: symbols.length, updated, failed };
}

/**
 * Build a quoted row payload for storage (id + timestamps) from a resolved
 * quote. Used by the DB-backed wrapper to share a single row shape.
 */
export function stockPriceRowFromQuote(
  quote: StockQuoteInput,
  now: Date = new Date()
): {
  id: string;
  symbol: string;
  priceDate: string;
  closePrice: string;
  currency: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
} {
  const ts = now.toISOString();
  return {
    id: randomUUID(),
    symbol: quote.symbol,
    priceDate: quote.priceDate,
    closePrice: String(quote.close),
    currency: quote.currency,
    source: null,
    createdAt: ts,
    updatedAt: ts,
  };
}
