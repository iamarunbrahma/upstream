// For a payout batch the settlement job marked "needs checking": PayPal may have sent it, too long ago to resend
// safely. Look in PayPal for a batch whose sender_batch_id is the settlement id first.
// Usage: pnpm --filter web resolve-payout-check <settlement-id> resend      (PayPal has no such batch: send it)
//        pnpm --filter web resolve-payout-check <settlement-id> give-back   (return the money to the developers)
import { getDeps } from "../lib/deps";
import { resolvePayoutCheck } from "../lib/funding/payouts";

const [settlementId, action] = process.argv.slice(2);
if (!settlementId || (action !== "resend" && action !== "give-back")) {
  console.error("Usage: pnpm --filter web resolve-payout-check <settlement-id> resend|give-back");
  process.exit(1);
}
const { db } = await getDeps();
if (!(await resolvePayoutCheck(db, settlementId, action))) {
  console.error(`Settlement ${settlementId} isn't waiting on a check, so nothing was changed.`);
  process.exit(1);
}
console.log(action === "resend" ? "Done. The next run sends this batch." : "Done. Its money is back in the developers' budgets.");
process.exit(0);
