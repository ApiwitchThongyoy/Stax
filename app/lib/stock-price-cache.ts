import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./drizzle-db";
import { stockPrices } from "../db/schema";
import type { StockQuoteInput } from "./stock-price-provider";
import { isValidStockQuote, normalizeStockSymbol, stockPriceRowFromQuote } from "./stock-price-provider";

/**
 * DB cache for daily stock closes. Mirror of exchange-rate-cache: read/get
 * helpers plus an idempotent per-(symbol, price_date) upsert. Prices are global
 * (not user-scoped) market reference data — see the schema comment.
 */

export interface CachedStockPrice {
  id: string;
  symbol: string;
  priceDate: string;
  closePrice: string;
  currency: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Latest stored row for a symbol (newest price_date first), or null. */
export async function getLatestStockPrice(
  symbol: string
): Promise<CachedStockPrice | null> {
  const rows = await db
    .select()
    .from(stockPrices)
    .where(eq(stockPrices.symbol, symbol))
    .orderBy(desc(stockPrices.priceDate))
    .limit(1)
    .execute();

  return rows.length > 0 ? (rows[0] as CachedStockPrice) : null;
}

/**
 * Latest stored row per requested symbol. One query, deduped in JS: rows are
 * ordered by (symbol asc, price_date desc) and only the first row of each
 * symbol is kept.
 */
export async function getLatestStockPricesForSymbols(
  symbols: string[]
): Promise<Map<string, CachedStockPrice>> {
  const wanted = symbols.map((s) => s.toUpperCase());
  if (wanted.length === 0) return new Map();

  const rows = await db
    .select()
    .from(stockPrices)
    .where(inArray(stockPrices.symbol, wanted))
    .orderBy(stockPrices.symbol, desc(stockPrices.priceDate))
    .execute();

  const map = new Map<string, CachedStockPrice>();
  for (const row of rows) {
    const cur = row as CachedStockPrice;
    if (!map.has(cur.symbol)) {
      map.set(cur.symbol, cur);
    }
  }
  return map;
}

/**
 * Insert a new daily close, or update the existing row for the same
 * (symbol, price_date). Idempotent — a weekend re-fetch that hands back Friday's
 * close refreshes `updated_at` without duplicating rows.
 */
export async function upsertStockPrice(
  input: StockQuoteInput
): Promise<CachedStockPrice> {
  const symbol = normalizeStockSymbol(input.symbol);
  if (!symbol || !isValidStockQuote(input)) throw new Error("Invalid stock quote");
  const row = stockPriceRowFromQuote({ ...input, symbol });
  const [stored] = await db.insert(stockPrices).values(row)
    .onConflictDoUpdate({
      target: [stockPrices.symbol, stockPrices.priceDate],
      set: { closePrice: row.closePrice, currency: row.currency, updatedAt: row.updatedAt },
    })
    .returning();
  return stored;
}
