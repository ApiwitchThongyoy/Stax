import { eq, sql, and } from "drizzle-orm";
import { db } from "./drizzle-db";
import { capitalTransactions } from "../db/schema";

export interface DailyAggregationRow {
  date: string;
  transactionCount: number;
  totalAmountThb: string;
}

export interface DailyAggregationByCurrencyRow {
  date: string;
  currency: string;
  transactionCount: number;
  totalAmountForeign: string;
  totalAmountThb: string;
}

/**
 * Aggregate daily total THB per user.
 * Groups by transaction_date, sums amount_thb, counts transactions.
 * Does NOT sum amount_foreign (mixed currencies would be meaningless).
 */
export async function getDailyAggregation(
  userId: string
): Promise<DailyAggregationRow[]> {
  const rows = await db
    .select({
      date: capitalTransactions.transactionDate,
      transactionCount: sql<number>`count(*)::int`,
      totalAmountThb: sql<string>`sum(${capitalTransactions.amountThb})::text`,
    })
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .groupBy(capitalTransactions.transactionDate)
    .orderBy(capitalTransactions.transactionDate);

  return rows;
}

/**
 * Aggregate daily totals broken down by currency per user.
 * Safe for mixed-currency data — never mixes different currencies.
 */
export async function getDailyAggregationByCurrency(
  userId: string
): Promise<DailyAggregationByCurrencyRow[]> {
  const rows = await db
    .select({
      date: capitalTransactions.transactionDate,
      currency: capitalTransactions.currency,
      transactionCount: sql<number>`count(*)::int`,
      totalAmountForeign: sql<string>`sum(${capitalTransactions.amountForeign})::text`,
      totalAmountThb: sql<string>`sum(${capitalTransactions.amountThb})::text`,
    })
    .from(capitalTransactions)
    .where(eq(capitalTransactions.userId, userId))
    .groupBy(capitalTransactions.transactionDate, capitalTransactions.currency)
    .orderBy(capitalTransactions.transactionDate, capitalTransactions.currency);

  return rows;
}
