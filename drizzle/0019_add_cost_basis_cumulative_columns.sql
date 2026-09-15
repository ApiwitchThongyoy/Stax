-- Webull Average Cost: add the lifetime accumulator to cost_basis_state.
-- `cum_quantity` = total qty accumulated by BUYs (the Webull divisor, NEVER
-- reduced by SELL); `cum_cost` = price×qty for every BUY (fees excluded).
-- avg_cost = cum_cost / cum_quantity. Legacy rows default to 0 and are
-- hydrated by loadCostBasisState as "everything bought at the stored average".
ALTER TABLE "cost_basis_state" ADD COLUMN "cum_quantity" numeric NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE "cost_basis_state" ADD COLUMN "cum_cost" numeric NOT NULL DEFAULT '0';