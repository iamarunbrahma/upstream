import { readFileSync, writeFileSync } from "node:fs";
import { createPayPalApi } from "../lib/paypal/api";
import { createPayPalHttp, paypalApiBase } from "../lib/paypal/client";
import { ensureCatalog } from "../lib/paypal/plans";

const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in apps/web/.env.local first.");
  process.exit(1);
}
const api = createPayPalApi(createPayPalHttp({ clientId, clientSecret, baseUrl: paypalApiBase(process.env.PAYPAL_API_BASE) }));
const { productId, envLines } = await ensureCatalog(api);
const lines = [...envLines, `NEXT_PUBLIC_PAYPAL_CLIENT_ID=${clientId}`];
console.log(`product ${productId}`);
for (const line of envLines) console.log(line);

if (process.argv.includes("--write")) {
  const path = new URL("../.env.local", import.meta.url);
  let text = readFileSync(path, "utf8");
  for (const line of lines) {
    const key = line.slice(0, line.indexOf("="));
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(path, text);
  console.log("written to apps/web/.env.local");
}
