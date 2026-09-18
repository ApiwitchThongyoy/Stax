-- R4 (fees accounting finalization): persist monthly-fee-aggregate provenance.
--
-- The statement parser (Pass 3) marks a fee row that is the MONTHLY SUM of
-- statement-currency fees (one USD row AND one THB row per currency) as a
-- monthly aggregate. Such rows are informational only: the month's fees are
-- real but do not correspond to a single underlying trade, so the posting
-- engine SKIPS them instead of posting a (double-counted) expense line.
--
-- Provenance is tri-state:
--   TRUE  - confirmed parser-generated monthly aggregate (rows imported after
--           this migration). Rebuild paths keep them SKIPPED.
--   FALSE - confirmed standalone / non-aggregate fee (rows imported after this
--           migration). Rebuild paths post it once.
--   NULL  - legacy / unknown provenance. Before this migration the parser
--           emitted IDENTICAL persisted shapes for a monthly aggregate AND a
--           genuine standalone fee (category=expense, section=the standard
--           Thai broker fee label or VAT, type=CASH_OUT, trade fields NULL, no
--           description column), so a historical row CANNOT be classified.
--           NULL deliberately does NOT mean FALSE: we never fabricate a
--           confirmed standalone verdict for an unprovable row.
--
-- FINAL posting policy (posting-engine, expense branch):
--   TRUE  -> SKIPPED (zero journal lines): the month's fees are already in the
--            per-trade postings (BUY fee leg / SELL net proceeds).
--   FALSE -> POSTED normally as a real standalone expense.
--   NULL  -> SKIPPED (zero journal lines) with the explicit skip reason
--            "legacy fee provenance unknown - re-import required for
--            deterministic classification". NULL means we cannot prove whether
--            the historical row was a monthly aggregate or a genuine standalone
--            fee, so posting it could double-count the month's fees — it is
--            NEVER treated as a confirmed standalone. The stored flag stays
--            NULL so every reader can still see the provenance is UNKNOWN.
--
-- No DEFAULT and no NOT NULL: ADD COLUMN therefore leaves every pre-existing
-- row NULL (unknown) - never a fabricated FALSE. There is intentionally NO
-- backfill: any automated classification would have to infer provenance from
-- the section label, which would either fabricate it or silently misclassify a
-- genuine standalone fee.
--
-- The ONLY way to obtain a deterministic TRUE/FALSE for an old statement is to
-- DELETE it and re-import the PDF: the re-parse re-runs the parser's Pass 3 and
-- re-emits the aggregate rows WITH TRUE and the standalone rows WITH FALSE.
ALTER TABLE "Capital_Transactions"
  ADD COLUMN "is_monthly_fee_aggregate" boolean;

ALTER TABLE "journal_entries"
  ADD COLUMN "is_monthly_fee_aggregate" boolean;