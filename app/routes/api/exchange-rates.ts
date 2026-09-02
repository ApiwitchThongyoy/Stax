import type { Route } from "./+types/exchange-rates";
import { verifyAuth, isAuthError, authErrorResponse } from "~/lib/auth-middleware";
import {
  resolveHistoricalFxRate,
  normalizeCachedSource,
} from "~/lib/historical-fx-provider";
import { getCachedRatesForDate } from "~/lib/exchange-rate-cache";

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function action() {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}

/**
 * GET /api/v1/exchange-rates?date=YYYY-MM-DD&currency=USD
 *
 * Returns a historical FX rate for a specific date and currency.
 * - If date is omitted, defaults to today.
 * - If currency is omitted, returns the cached rates for that date (THB = 1 always).
 * - THB always returns rate=1.
 * - On provider failure/weekend/missing data, returns { available: false } —
 *   never invents rates. The provider is keyless (no BOT_API_KEY required).
 *
 * Authenticated endpoint — user-scoped (auth required).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await verifyAuth(request);
  if (isAuthError(auth)) {
    return authErrorResponse(auth);
  }

  const url = new URL(request.url);
  const rawDate = url.searchParams.get("date");
  const currency = url.searchParams.get("currency");

  const rateDate = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : formatDate(new Date());

  try {
    if (currency) {
      const upperCurrency = currency.trim().toUpperCase();
      const result = await resolveHistoricalFxRate(rateDate, upperCurrency);
      if (!result) {
        return Response.json(
          {
            success: true,
            data: {
              available: false,
              date: rateDate,
              currency: upperCurrency,
              reason: "Rate not available for this date/currency (historical FX provider returned no data, weekend, or holiday)",
            },
          },
          { status: 200 }
        );
      }
      return Response.json(
        {
          success: true,
          data: {
            available: true,
            date: rateDate,
            currency: upperCurrency,
            rate: result.rate,
            source: result.source,
          },
        },
        { status: 200 }
      );
    }

    const cached = await getCachedRatesForDate(rateDate);
    const entries: Array<{ currency: string; rate: number; source: string }> = [
      { currency: "THB", rate: 1, source: "THB is base currency" },
    ];
    for (const [cachedCurrency, entry] of cached) {
      if (cachedCurrency === "THB") continue;
      entries.push({
        currency: cachedCurrency,
        rate: parseFloat(entry.rate),
        source: normalizeCachedSource(entry.source),
      });
    }

    return Response.json(
      {
        success: true,
        data: {
          available: entries.length > 1,
          date: rateDate,
          rates: entries,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("ExchangeRates GET: failed", error);
    return Response.json(
      {
        success: true,
        data: {
          available: false,
          date: rateDate,
          reason: "Internal error while fetching exchange rates",
        },
      },
      { status: 200 }
    );
  }
}
