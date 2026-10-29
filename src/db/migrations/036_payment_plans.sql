-- 036: Payment plans on invoices (Homer, 2026-10-29): community work paid off in 5 to 10 monthly payments, no
-- interest. The invoice is still one invoice for its full amount; plan_count payments, the first due plan_first_due
-- and then monthly, split evenly (src/core/paymentPlan.js). Only the payments past their own due date count as
-- past due. The plan can be added or changed later (it moves no money), so it is not part of the posted entry.
ALTER TABLE documents ADD COLUMN plan_count smallint CHECK (plan_count IS NULL OR plan_count BETWEEN 2 AND 60);
ALTER TABLE documents ADD COLUMN plan_first_due date;
ALTER TABLE documents ADD CONSTRAINT documents_plan_check
  CHECK ((plan_count IS NULL) = (plan_first_due IS NULL) AND (plan_count IS NULL OR kind = 'invoice'));
