import {
  getCachedRate,
  upsertCachedRate,
} from "./exchange-rate-cache";

/**
 * Historical exchange-rate provider (keyless), used as the FX fallback when a
 * statement does NOT print its own rate. The Bank-of-Thailand (BOT) integration
 * has been retired: no BOT_API_KEY exists, no BOT endpoints are called, and no
 * BOT wording is surfaced anywhere in the app.
 *
 * Priority when resolving a transaction's THB conversion rate:
 *   A. Statement-provided FX (fx_rate_statement) — authoritative, always wins.
 *   B. This historical provider (historical-fx-provider), cache-first.
 *   C. THB = 1 (base currency). Never a fabricated rate.
 *
 * The provider itself is abstracted behind `HistoricalFxSource` so it can be
 * swapped later; the default implementation reads ECB reference rates from
 * frankfurter.app (no API key). Every lookup is graceful: a provider failure is
 * logged and yields null — it never throws, never guesses, and never breaks an
 * import.
 */

/** Canonical source label for the historical FX provider across cache + responses. */
export const HISTORICAL_FX_SOURCE_NAME = "historical-fx-provider";

export interface HistoricalFxRate {
  rate: number;
  source: string;
}

/** Outbound strategy for a single date+currency lookup (no auth, no key). */
export interface HistoricalFxSource {
  name: string;
  getRate(rateDate: string, currency: string): Promise<number | null>;
}

const REQUEST_TIMEOUT_MS = 15_000;
const FRANKFURTER_API_BASE = "https://api.frankfurter.app";

/**
 * ECB reference-rate based historical provider (keyless). Returns the THB per 1
 * unit of `currency` on `rateDate`, or null when the pair/date is unavailable.
 */
export const frankfurterFxSource: HistoricalFxSource = {
  name: HISTORICAL_FX_SOURCE_NAME,
  async getRate(rateDate: string, currency: string): Promise<number | null> {
    const url = new URL(`${FRANKFURTER_API_BASE}/${rateDate}`);
    url.searchParams.set("from", currency);
    url.searchParams.set("to", "THB");

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(
          `Historical FX provider returned status ${response.status} for ${currency} on ${rateDate}`
        );
        return null;
      }

      const body = (await response.json()) as {
        base?: string;
        date?: string;
        rates?: Record<string, number | string>;
      };
      const thbRate = body?.rates?.THB;
      if (thbRate === undefined || thbRate === null) {
        console.warn(
          `Historical FX provider returned no THB rate for ${currency} on ${rateDate}`
        );
        return null;
      }

      const rate = parseFloat(String(thbRate));
      if (Number.isNaN(rate) || rate <= 0) {
        console.warn(
          `Historical FX provider returned invalid rate value: ${String(thbRate)} for ${currency}`
        );
        return null;
      }

      return rate;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.warn(
          `Historical FX provider request timed out for ${currency} on ${rateDate}`
        );
      } else {
        console.warn(
          `Historical FX provider network error for ${currency} on ${rateDate}:`,
          error
        );
      }
      return null;
    }
  },
};

/**
 * Normalize a cached `source` label. Legacy cache rows written by the retired
 * BOT integration carry the same daily-rate numbers; keep the values but never
 * surface the retired provider name in the UI.
 */
export function normalizeCachedSource(
  source: string | null | undefined
): string {
  if (!source) return HISTORICAL_FX_SOURCE_NAME;
  const cleaned = source.replace(/BOT\s*API/i, HISTORICAL_FX_SOURCE_NAME).trim();
  return cleaned.length > 0 ? cleaned : HISTORICAL_FX_SOURCE_NAME;
}

/**
 * Resolve a historical rate for a date+currency, cache-first:
 *   1. THB always resolves to rate 1 (base currency) — no cache, no network.
 *   2. Cache hit → served from the cache (source label normalized).
 *   3. Cache miss → provider lookup; on success the rate is seeded into the
 *      cache so subsequent calls never re-hit the network.
 *   4. Provider failure/missing data → null (graceful, never a fabricated rate).
 */
export async function resolveHistoricalFxRate(
  rateDate: string,
  currency: string,
  source: HistoricalFxSource = frankfurterFxSource
): Promise<HistoricalFxRate | null> {
  if (currency === "THB") {
    return { rate: 1, source: "THB is base currency" };
  }

  const cached = await getCachedRate(rateDate, currency);
  if (cached) {
    return {
      rate: parseFloat(cached.rate),
      source: normalizeCachedSource(cached.source),
    };
  }

  const fresh = await source.getRate(rateDate, currency);
  if (fresh !== null && Number.isFinite(fresh) && fresh > 0) {
    await upsertCachedRate({
      rateDate,
      currency,
      rate: fresh,
      source: source.name,
    });
    return { rate: fresh, source: source.name };
  }

  return null;
}