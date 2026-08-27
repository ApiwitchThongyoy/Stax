import { getCachedRate, upsertCachedRate, type CachedRate } from "./exchange-rate-cache";

const BOT_API_BASE = "https://apigw1.bot.or.th/bot/public/Stat-ExchangeRate/v2";

const REQUEST_TIMEOUT_MS = 15_000;
const BOT_API_KEY_ENV = "BOT_API_KEY";

export interface BotRateResponse {
  period: string;
  currencyId: string;
  currencyNameTh: string;
  currencyNameEng: string;
  buyingSight: string;
  buyingTransfer: string;
  selling: string;
  midRate: string;
}

interface BotApiResult {
  success: string;
  api: string;
  timestamp: string;
  data?: {
    data_header?: Record<string, unknown>;
    data_detail?: Array<Record<string, string>>;
  };
  error?: Array<{ code: string; message: string }>;
}

interface BotApiResponse {
  result: BotApiResult;
}

function getApiKey(): string | null {
  return process.env[BOT_API_KEY_ENV] ?? null;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function today(): string {
  return formatDate(new Date());
}

/**
 * Fetch daily average exchange rates from the BOT API for a specific date and currency.
 * Checks the cache first — if a cached entry exists for that date+currency, returns it
 * without calling the external API.
 *
 * On cache miss, calls the BOT API, validates the response, saves to cache, and returns.
 *
 * @param rateDate - Date in YYYY-MM-DD format
 * @param currency - Currency code (e.g., "USD", "HKD", "CNH")
 * @returns The exchange rate (THB per 1 unit of foreign currency) or null if unavailable
 */
export async function getExchangeRate(
  rateDate: string,
  currency: string
): Promise<{ rate: number; source: string } | null> {
  if (currency === "THB") {
    return { rate: 1, source: "THB is base currency" };
  }

  const cached = await getCachedRate(rateDate, currency);
  if (cached) {
    return { rate: parseFloat(cached.rate), source: cached.source ?? "cache" };
  }

  const fresh = await fetchFromBotApi(rateDate, currency);
  return fresh;
}

/**
 * Fetch daily average exchange rates from the BOT API for a specific date.
 * Returns all available currencies for that date.
 * Checks cache first for each currency.
 */
export async function getExchangeRatesForDate(
  rateDate: string
): Promise<Map<string, { rate: number; source: string }>> {
  const results = new Map<string, { rate: number; source: string }>();
  results.set("THB", { rate: 1, source: "THB is base currency" });

  const fresh = await fetchAllRatesFromBotApi(rateDate);
  if (fresh) {
    for (const entry of fresh) {
      results.set(entry.currencyId, {
        rate: parseFloat(entry.midRate),
        source: "BOT API",
      });
    }
  }

  return results;
}

async function fetchFromBotApi(
  rateDate: string,
  currency: string
): Promise<{ rate: number; source: string } | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("BOT_API_KEY is not set. Cannot fetch exchange rate from BOT API.");
    return null;
  }

  const url = new URL(`${BOT_API_BASE}/DAILY_AVG_EXG_RATE/`);
  url.searchParams.set("start_period", rateDate);
  url.searchParams.set("end_period", rateDate);
  url.searchParams.set("currency", currency);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "api-key": apiKey,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`BOT API returned status ${response.status} for ${currency} on ${rateDate}`);
      return null;
    }

    const body = await response.json() as BotApiResponse;
    const result = body.result;

    if (!result || result.success !== "true") {
      const errors = result?.error?.map((e) => e.message).join("; ") ?? "unknown error";
      console.error(`BOT API error for ${currency} on ${rateDate}: ${errors}`);
      return null;
    }

    const details = result.data?.data_detail;
    if (!details || details.length === 0) {
      console.warn(`BOT API returned no data for ${currency} on ${rateDate}`);
      return null;
    }

    const entry = details[0];
    const midRate = entry.mid_rate ?? entry.midRate;
    if (!midRate) {
      console.warn(`BOT API response missing mid_rate for ${currency} on ${rateDate}`);
      return null;
    }

    const rate = parseFloat(midRate);
    if (Number.isNaN(rate) || rate <= 0) {
      console.warn(`BOT API returned invalid rate value: ${midRate} for ${currency}`);
      return null;
    }

    await upsertCachedRate({
      rateDate,
      currency,
      rate,
      source: "BOT API",
    });

    return { rate, source: "BOT API" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error(`BOT API request timed out for ${currency} on ${rateDate}`);
    } else {
      console.error(`BOT API network error for ${currency} on ${rateDate}:`, error);
    }
    return null;
  }
}

async function fetchAllRatesFromBotApi(
  rateDate: string
): Promise<BotRateResponse[] | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("BOT_API_KEY is not set. Cannot fetch exchange rates from BOT API.");
    return null;
  }

  const url = new URL(`${BOT_API_BASE}/DAILY_AVG_EXG_RATE/`);
  url.searchParams.set("start_period", rateDate);
  url.searchParams.set("end_period", rateDate);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "api-key": apiKey,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`BOT API returned status ${response.status} for date ${rateDate}`);
      return null;
    }

    const body = await response.json() as BotApiResponse;
    const result = body.result;

    if (!result || result.success !== "true") {
      const errors = result?.error?.map((e) => e.message).join("; ") ?? "unknown error";
      console.error(`BOT API error for date ${rateDate}: ${errors}`);
      return null;
    }

    const details = result.data?.data_detail;
    if (!details || details.length === 0) {
      console.warn(`BOT API returned no data for date ${rateDate}`);
      return null;
    }

    const parsed: BotRateResponse[] = [];
    for (const entry of details) {
      const midRate = entry.mid_rate;
      if (!midRate) continue;

      const rate = parseFloat(midRate);
      if (Number.isNaN(rate) || rate <= 0) continue;

      const currencyId = entry.currency_id;
      if (!currencyId) continue;

      parsed.push({
        period: entry.period ?? rateDate,
        currencyId,
        currencyNameTh: entry.currency_name_th ?? "",
        currencyNameEng: entry.currency_name_eng ?? "",
        buyingSight: entry.buying_sight ?? "",
        buyingTransfer: entry.buying_transfer ?? "",
        selling: entry.selling ?? "",
        midRate,
      });

      await upsertCachedRate({
        rateDate,
        currency: currencyId,
        rate,
        source: "BOT API",
      });
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error(`BOT API request timed out for date ${rateDate}`);
    } else {
      console.error(`BOT API network error for date ${rateDate}:`, error);
    }
    return null;
  }
}
