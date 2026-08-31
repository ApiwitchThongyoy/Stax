// W1-2 — Deterministic Decimal tax engine unit tests.
//
// These tests exercise the Decimal Core Engine (tax-engine.ts) directly and do
// NOT touch a database. They verify the per-transaction taxable rule (no loss
// offset across transactions) and decimal-precision correctness.
//
// Run:  npx tsx scripts/test-tax-engine.mts
import { strict as assert } from "node:assert";
import {
  calculateTax,
  signedTransactionAmountThb,
  buildNonComputableTaxRecon,
  reconResultWithoutRealizedGainLoss,
} from "../app/lib/tax-engine";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function tx(id: string, realizedGainLossThb: string) {
  return { transactionId: id, realizedGainLossThb };
}

async function main() {
  console.log("\n=== W1-2: DECIMAL TAX CORE ENGINE ===\n");

  // ------------------------------------
  // Case A: profit 10000, loss -4000 -> taxable total = 10000
  // ------------------------------------
  {
    const r = calculateTax([tx("a1", "10000"), tx("a2", "-4000")]);
    const a1 = r.transactions.find((t) => t.transactionId === "a1")!;
    const a2 = r.transactions.find((t) => t.transactionId === "a2")!;
    ok(a1.taxableAmountThb === "10000.00", "A: profit 10000 taxable = 10000.00");
    ok(a1.isTaxable === true, "A: profit is taxable");
    ok(a2.taxableAmountThb === "0.00", "A: loss -4000 taxable = 0.00 (NOT offset)");
    ok(a2.isTaxable === false, "A: loss is not taxable");
    ok(r.totalTaxableAmountThb === "10000.00", "A: total = 10000.00 (loss NOT deducted)");
  }

  // ------------------------------------
  // Case B: profit 10000 + profit 5000 -> taxable total = 15000
  // ------------------------------------
  {
    const r = calculateTax([tx("b1", "10000"), tx("b2", "5000")]);
    ok(r.totalTaxableAmountThb === "15000.00", "B: total of two profits = 15000.00");
    ok(r.transactions.every((t) => t.isTaxable), "B: both profits are taxable");
  }

  // ------------------------------------
  // Case C: loss -3000 + loss -2000 -> taxable total = 0
  // ------------------------------------
  {
    const r = calculateTax([tx("c1", "-3000"), tx("c2", "-2000")]);
    ok(r.totalTaxableAmountThb === "0.00", "C: total of two losses = 0.00");
    ok(r.transactions.every((t) => t.taxableAmountThb === "0.00"), "C: every loss taxable = 0");
    ok(r.transactions.every((t) => !t.isTaxable), "C: no transaction is taxable when all losses");
  }

  // ------------------------------------
  // Case D: decimal precision 0.1 + 0.2 must not expose float artifacts
  // ------------------------------------
  {
    // 0.1 and 0.2 cannot be represented cleanly in binary float; Decimal must
    // produce exactly 0.30 and the taxable total must be exactly 0.30, not
    // 0.30000000000000004.
    const r = calculateTax([tx("d1", "0.1"), tx("d2", "0.2")]);
    ok(
      r.totalTaxableAmountThb === "0.30",
      `D: 0.1 + 0.2 = 0.30 exactly (got ${r.totalTaxableAmountThb})`
    );
    ok(r.transactions[0].taxableAmountThb === "0.10", "D: first taxable = 0.10");
    ok(r.transactions[1].taxableAmountThb === "0.20", "D: second taxable = 0.20");
  }

  // ------------------------------------
  // Case E: large / high-precision monetary value
  // ------------------------------------
  {
    const large = "9999999999999999.99999999";
    const r = calculateTax([tx("e1", large), tx("e2", "-0.00000001")]);
    // toFixed(2) rounds deterministically to 10000000000000000.00 (>= 16 sig digits,
    // no float artifact — Decimal handles the full precision internally).
    ok(r.transactions[0].taxableAmountThb === "10000000000000000.00", "E: large high-precision positive handled deterministically");
    ok(r.transactions[1].taxableAmountThb === "0.00", "E: tiny negative loss -> 0 (no offset)");
    ok(r.totalTaxableAmountThb === "10000000000000000.00", "E: total preserves large precision");
  }

  // ------------------------------------
  // Extra: invalid / non-finite input handled deterministically
  // ------------------------------------
  {
    const r = calculateTax([
      tx("f1", "100"),
      tx("f2", "0"),
      tx("f3", "abc"),
    ]);
    ok(r.transactions[2].taxableAmountThb === "0.00", "non-finite input treated as 0");
    ok(r.transactions[2].reason.includes("invalid"), "non-finite input has invalid reason");
  }

  // ------------------------------------
  // Signed neutral raw cash value + explicit "not computable" reconstruction.
  // The schema stores raw cash only and has no cost basis / proceeds, so the
  // API must NOT fabricate realizedGainLossThb or a taxable total.
  // ------------------------------------
  {
    ok(
      signedTransactionAmountThb({ transactionId: "x", amountThb: "100.00", type: "CASH_IN" }) === "100.00",
      "signedTransactionAmountThb CASH_IN -> +100.00 (neutral raw cash)"
    );
    ok(
      signedTransactionAmountThb({ transactionId: "x", amountThb: "40.00", type: "CASH_OUT" }) === "-40.00",
      "signedTransactionAmountThb CASH_OUT -> -40.00 (neutral raw cash)"
    );
    ok(
      signedTransactionAmountThb({ transactionId: "x", amountThb: "bad", type: "CASH_IN" }) === "0.00",
      "signedTransactionAmountThb malformed -> 0.00"
    );

    const r = reconResultWithoutRealizedGainLoss({
      transactionId: "x",
      amountThb: "100.00",
      type: "CASH_IN",
    });
    ok(r.transactionAmountThb === "100.00", "recon exposes neutral transactionAmountThb");
    ok(r.realizedGainLossThb === null, "recon does NOT fabricate realizedGainLossThb");
    ok(r.taxableAmountThb === null, "recon does NOT fabricate taxableAmountThb");
    ok(r.isTaxable === null, "recon does NOT fabricate isTaxable");
    ok(r.status === "not-computable", "recon marks status not-computable");

    const summary = buildNonComputableTaxRecon([
      { transactionId: "a", amountThb: "100.00", type: "CASH_IN" },
      { transactionId: "b", amountThb: "40.00", type: "CASH_OUT" },
    ]);
    ok(summary.computable === false, "summary.computable === false");
    ok(summary.totalTaxableAmountThb === null, "summary never fabricates a taxable total");
    ok(
      summary.transactions.length === 2 &&
        summary.transactions.every((t) => t.taxableAmountThb === null),
      "summary marks every row non-computable"
    );
  }

  assert.ok(true, "test harness sanity");

  console.log(`\n================ SUMMARY ================`);
  console.log(`PASS: ${passed}   FAIL: ${failed}`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test crashed:", e);
  process.exit(1);
});
