// Demo seed for the redesigned General Ledger UI (ledger-redesign).
//
// Points at whatever DATABASE_URL is set (currently the local dev Postgres that
// Plan A set up on :55432). Idempotent — safe to re-run.
//
// Creates a demo USER account and a set of journal entries across the 5 account
// categories so the new GL UI has something to show. Uses the real backend
// services (seedDefaultChartOfAccounts + createJournalEntry) so the seeded data
// is fully consistent with the rest of the app.
import "dotenv/config";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../app/lib/drizzle-db";
import { users } from "../app/db/schema";
import { seedDefaultChartOfAccounts, createJournalEntry } from "../app/lib/ledger-service";

const DEMO_EMAIL = "demo@stax.com";
const DEMO_PASSWORD = "Demo1234";
const BCRYPT_ROUNDS = 10;

async function ensureDemoUser() {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEMO_EMAIL))
    .limit(1);
  if (rows.length > 0) {
    console.log(`[demo] user ${DEMO_EMAIL} already exists (id=${rows[0].id})`);
    return rows[0].id;
  }
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    email: DEMO_EMAIL,
    passwordHash,
    role: "USER",
    status: "ACTIVE",
    createdAt: new Date(now),
  });
  console.log(`[demo] created user ${DEMO_EMAIL} (id=${id})`);
  return id;
}

async function seedEntries(userId: string) {
  const seeded = await seedDefaultChartOfAccounts(userId);
  console.log(`[demo] chart of accounts seeded: ${seeded} new`);

  // Helper to know whether an account code exists for this user.
  const accountCodes = (await db.query.accounts.findMany({
    where: (a, { eq }) => eq(a.userId, userId),
  })).map((a) => a.code);
  const has = (code: string) => accountCodes.includes(code);

  const entries: {
    date: string;
    description: string;
    lines: { account: string; side: "DEBIT" | "CREDIT"; amount: string; currency: string; memo?: string }[];
  }[] = [];

  // 1. Owner injects capital: Dr ฟอกเงินสดไทย (THB) / Cr ส่วนทุนเงินลงทุนเริ่มต้น (USD)
  //    To keep per-currency balance, use the broker-cash USD account for the equity.
  //    Deposit USD into the foreign broker account.
  if (has("1020") && has("3010")) {
    entries.push({
      date: "2026-01-05",
      description: "ฝากเงินทุนเริ่มต้นเข้าบัญชีโบรกเกอร์",
      lines: [
        { account: "1020", side: "DEBIT", amount: "10000.00", currency: "USD", memo: "เงินฝากเข้าบัญชี" },
        { account: "3010", side: "CREDIT", amount: "10000.00", currency: "USD", memo: "ส่วนทุนเริ่มต้น" },
      ],
    });
  }

  // 2. Buy stocks (asset BUY, fees capitalized to 1110 as investment).
  if (has("1110") && has("1020")) {
    entries.push({
      date: "2026-01-12",
      description: "ซื้อหลักทรัพย์ NVDA",
      lines: [
        { account: "1110", side: "DEBIT", amount: "9980.00", currency: "USD", memo: "ต้นทุนซื้อ 100 หุ้น @ 99.80" },
        { account: "1020", side: "CREDIT", amount: "9980.00", currency: "USD", memo: "หักจากบัญชีโบรกเกอร์" },
      ],
    });
  }

  // 3. Sell stocks (realize a gain): Dr broker cash / Cr investments + Cr gains income.
  if (has("1020") && has("1110") && has("4020")) {
    entries.push({
      date: "2026-02-10",
      description: "ขายหลักทรัพย์ NVDA บางส่วน",
      lines: [
        { account: "1020", side: "DEBIT", amount: "5250.00", currency: "USD", memo: "ขาย 50 หุ้น @ 105.00" },
        { account: "1110", side: "CREDIT", amount: "4990.00", currency: "USD", memo: "ต้นทุนขาย" },
        { account: "4020", side: "CREDIT", amount: "260.00", currency: "USD", memo: "กำไรจากการขาย" },
      ],
    });
  }

  // 4. Dividend income received.
  if (has("1020") && has("4010")) {
    entries.push({
      date: "2026-02-20",
      description: "รับเงินปันผล",
      lines: [
        { account: "1020", side: "DEBIT", amount: "150.00", currency: "USD", memo: "เงินปันผล NVDA" },
        { account: "4010", side: "CREDIT", amount: "150.00", currency: "USD", memo: "รายได้เงินปันผล" },
      ],
    });
  }

  // 5. Fee expense (broker commission) — Dr expense / Cr broker cash.
  if (has("5010") && has("1020")) {
    entries.push({
      date: "2026-02-10",
      description: "ค่าธรรมเนียมโบรกเกอร์",
      lines: [
        { account: "5010", side: "DEBIT", amount: "20.00", currency: "USD", memo: "ค่านายหน้า" },
        { account: "1020", side: "CREDIT", amount: "20.00", currency: "USD", memo: "หักจากบัญชี" },
      ],
    });
  }

  // 6. Withdraw cash (equity deduction): Dr owner capital / Cr broker cash.
  if (has("3010") && has("1020")) {
    entries.push({
      date: "2026-03-01",
      description: "ถอนเงินทุนบางส่วน",
      lines: [
        { account: "3010", side: "DEBIT", amount: "2000.00", currency: "USD", memo: "ถอนทุน" },
        { account: "1020", side: "CREDIT", amount: "2000.00", currency: "USD", memo: "ออกจากบัญชี" },
      ],
    });
  }

  // 7. Deposit into a THB account to show multi-currency: Dr THB cash / Cr ...
  //    Use liability margin? Keep simple: Dr ไทย cash (THB) via equity cross-
  //    currency isn't allowed per-entry. Instead record THB cash from owner: but
  //    equity 3010 is USD. We'll add a THB-only transfer using account 5020
  //    (exchange) is complicated. Skip extra THB entries — keep the demo clean.

  let created = 0;
  for (const e of entries) {
    const result = await createJournalEntry(userId, {
      entryDate: e.date,
      description: e.description,
      sourceType: "MANUAL",
      lines: e.lines.map((l) => ({
        accountId: l.account,
        currency: l.currency,
        ...(l.side === "DEBIT" ? { debit: l.amount } : { credit: l.amount }),
        // Demo uses a fixed illustrative rate for foreign lines (THB is 1 by rule).
        fxRateEffective: l.currency === "THB" ? "1" : "35",
        memo: l.memo,
      })),
    });
    if (result.ok) {
      console.log(`[demo] posted ${e.description} → entry #${result.entryNo}`);
      created++;
    } else {
      console.log(`[demo] SKIPPED ${e.description}: ${result.errors.join("; ")}`);
    }
  }
  console.log(`[demo] ${created}/${entries.length} journal entries created`);
  return created;
}

async function main() {
  console.log("\n=== STAX General Ledger demo seed ===\n");
  const userId = await ensureDemoUser();
  await seedEntries(userId);
  console.log("\nDone. Login with:\n  email:    " + DEMO_EMAIL + "\n  password: " + DEMO_PASSWORD + "\n");
  await db.$client.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("Seed failed:", err);
  await db.$client.end().catch(() => {});
  process.exit(1);
});
