// Sandbox only, for seeding a demo maintainer: records that a GitHub login can be paid at a PayPal account id,
// as if they had linked it `daysAgo` days ago (default 8, past the first-payout hold). Real maintainers sign in
// with GitHub and link PayPal themselves at /maintainer; if that login signs in later, the seeded claim is theirs.
// Usage: pnpm --filter web claim-maintainer <github-login> <paypal-payer-id> [days-ago]
import { getDeps } from "../lib/deps";
import { maintainers } from "../lib/db/schema";
import { paypalApiBase, SANDBOX_API } from "../lib/paypal/client";

const [login, payerId, daysAgo = "8"] = process.argv.slice(2);
if (!login || !payerId || !/^\d+$/.test(daysAgo)) {
  console.error("Usage: pnpm --filter web claim-maintainer <github-login> <paypal-payer-id> [days-ago]");
  process.exit(1);
}
if (paypalApiBase(process.env.PAYPAL_API_BASE) !== SANDBOX_API) {
  console.error("This only works against the PayPal sandbox. Real maintainers link PayPal themselves.");
  process.exit(1);
}
const claimedAt = new Date(Date.now() - Number(daysAgo) * 24 * 60 * 60 * 1000);
const { db } = await getDeps();
await db
  .insert(maintainers)
  .values({ login: login.toLowerCase(), paypalPayerId: payerId, claimedAt })
  .onConflictDoUpdate({ target: maintainers.login, set: { paypalPayerId: payerId, claimedAt } });
console.log(`${login.toLowerCase()} can now be paid at sandbox PayPal account ${payerId}, as if linked ${daysAgo} days ago.`);
process.exit(0);
