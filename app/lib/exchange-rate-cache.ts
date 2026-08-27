import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "./drizzle-db";
import { exchangeRateCache } from "../db/schema";

export interface CachedRate {
  id: string;
  rateDate: string;
  currency: string;
  rate: string;
  source: string | null;
  createdAt: string;
}

export interface UpsertRateInput {
  rateDate: string;
  currency: string;
  rate: number;
  source?: string;
}

/**
 * Look up a cached exchange rate for a given date and currency.
 * Returns the cached entry if found, or null if not in the cache.
 */
export async function getCachedRate(
  rateDate: string,
  currency: string
): Promise<CachedRate | null> {
  const rows = await db
    .select()
    .from(exchangeRateCache)
    .where(
      and(
        eq(exchangeRateCache.rateDate, rateDate),
        eq(exchangeRateCache.currency, currency)
      )
    )
    .limit(1)
    .execute();

  return rows.length > 0 ? (rows[0] as CachedRate) : null;
}

/**
 * Look up cached exchange rates for a given date across all currencies.
 * Returns a map of currency → rate for fast lookup.
 */
export async function getCachedRatesForDate(
  rateDate: string
): Promise<Map<string, CachedRate>> {
  const rows = await db
    .select()
    .from(exchangeRateCache)
    .where(eq(exchangeRateCache.rateDate, rateDate))
    .execute();

  const map = new Map<string, CachedRate>();
  for (const row of rows) {
    map.set(row.currency, row as CachedRate);
  }
  return map;
}

/**
 * Insert or update an exchange rate in the cache.
 * Uses upsert logic: if a cache entry for the same date+currency exists, update it;
 * otherwise insert a new row.
 */
export async function upsertCachedRate(
  input: UpsertRateInput
): Promise<CachedRate> {
  const now = new Date().toISOString();
  const existing = await getCachedRate(input.rateDate, input.currency);

  if (existing) {
    await db
      .update(exchangeRateCache)
      .set({
        rate: String(input.rate),
        source: input.source ?? existing.source,
        createdAt: now,
      })
      .where(eq(exchangeRateCache.id, existing.id))
      .execute();

    return {
      ...existing,
      rate: String(input.rate),
      source: input.source ?? existing.source,
      createdAt: now,
    };
  }

  const id = randomUUID();
  const newEntry: CachedRate = {
    id,
    rateDate: input.rateDate,
    currency: input.currency,
    rate: String(input.rate),
    source: input.source ?? null,
    createdAt: now,
  };

  await db
    .insert(exchangeRateCache)
    .values({
      id,
      rateDate: input.rateDate,
      currency: input.currency,
      rate: String(input.rate),
      source: input.source ?? null,
      createdAt: now,
    })
    .execute();

  return newEntry;
}

/**
 * Bulk upsert multiple exchange rates for the same date.
 * Used when fetching from the BOT API which returns all currencies for a date.
 */
export async function upsertCachedRates(
  rates: UpsertRateInput[]
): Promise<CachedRate[]> {
  const results: CachedRate[] = [];
  for (const rate of rates) {
    results.push(await upsertCachedRate(rate));
  }
  return results;
}
