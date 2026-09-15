-- Per-row investor note on a journal entry (the trading-journal "จดบันทึก").
-- Nullable free text, written ONLY by the investor through the journal note
-- endpoint (PUT/DELETE /api/v1/trading-journal/:transactionId/note). Never
-- written by imports, postings, backfills or reversals; never part of the
-- double-entry math. Missing note = the investor wrote nothing (honest null).
ALTER TABLE "journal_entries" ADD COLUMN "note" text;
