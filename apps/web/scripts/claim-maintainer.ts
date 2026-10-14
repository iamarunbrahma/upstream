// Sandbox only, for seeding a demo maintainer: records that a GitHub login can be paid at a PayPal account id,
// as if they had linked it `daysAgo` days ago (default 8, past the first-payout hold). Real maintainers sign in
// with GitHub and link PayPal themselves at /maintainer; if that login signs in later, the seeded claim is theirs.
// Usage: pnpm --filter web claim-maintainer <github-login> <paypal-payer-id> [days-ago]
import { eq } from "drizzle-orm";
import { getDeps } from "../lib/deps";
import { maintainers } from "../lib/db/schema";
import { paypalApiBase, SANDBOX_API } from "../lib/paypal/client";
import { createGithubGet } from "../lib/resolver/recipients";

const [login, payerId, daysAgo = "8"] = process.argv.slice(2);
if (!login || !payerId || !/^\d+$/.test(daysAgo)) {
  console.error("Usage: pnpm --filter web claim-maintainer <github-login> <paypal-payer-id> [days-ago]");
  process.exit(1);
}
if (paypalApiBase(process.env.PAYPAL_API_BASE) !== SANDBOX_API) {
  console.error("This only works against the PayPal sandbox. Real maintainers link PayPal themselves.");
  process.exit(1);
}
// Money is filed by GitHub account, so the seeded row needs that account's id.
const account = await createGithubGet(process.env.GITHUB_TOKEN)(`/users/${encodeURIComponent(login)}`);
const githubId = (account.body as { id?: unknown } | null)?.id;
if (account.status !== 200 || typeof githubId !== "number") {
  console.error(`GitHub doesn't know the account ${login} (status ${account.status}).`);
  process.exit(1);
}
const claimedAt = new Date(Date.now() - Number(daysAgo) * 24 * 60 * 60 * 1000);
const { db } = await getDeps();
const [signedIn] = await db.select({ login: maintainers.login }).from(maintainers).where(eq(maintainers.githubId, githubId)).limit(1);
if (signedIn) {
  console.error(`${login} has already signed in here; they link PayPal themselves at /maintainer.`);
  process.exit(1);
}
await db
  .insert(maintainers)
  .values({ login: login.toLowerCase(), githubId, paypalPayerId: payerId, claimedAt })
  .onConflictDoUpdate({ target: maintainers.login, set: { githubId, paypalPayerId: payerId, claimedAt } });
console.log(`${login.toLowerCase()} can now be paid at sandbox PayPal account ${payerId}, as if linked ${daysAgo} days ago.`);
process.exit(0);
