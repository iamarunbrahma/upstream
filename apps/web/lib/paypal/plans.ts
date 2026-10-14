import type { PayPalApi } from "./api";
import { fromCents } from "./money";

export const TIERS = [
  { key: "starter", cents: 500, label: "$5 a month" },
  { key: "builder", cents: 1500, label: "$15 a month" },
  { key: "team", cents: 5000, label: "$50 a month" },
] as const;

export type TierKey = (typeof TIERS)[number]["key"];
export const TIER_KEYS = TIERS.map((t) => t.key) as [TierKey, ...TierKey[]];

export const PRODUCT_NAME = "Upstream open-source budget";
export const planName = (cents: number) => `Upstream ${fromCents(cents)} USD a month`;

const ENV_NAMES: Record<TierKey, string> = {
  starter: "PAYPAL_PLAN_STARTER",
  builder: "PAYPAL_PLAN_BUILDER",
  team: "PAYPAL_PLAN_TEAM",
};

export function planIdsFromEnv(env: Record<string, string | undefined> = process.env): Partial<Record<TierKey, string>> {
  const out: Partial<Record<TierKey, string>> = {};
  for (const t of TIERS) {
    const v = env[ENV_NAMES[t.key]];
    if (v) out[t.key] = v;
  }
  return out;
}

/** Creates the product and one active monthly plan per tier when they're missing. Safe to run again. */
export async function ensureCatalog(api: PayPalApi): Promise<{ productId: string; planIds: Record<TierKey, string>; envLines: string[] }> {
  const product =
    (await api.findProductByName(PRODUCT_NAME)) ??
    (await api.createProduct(PRODUCT_NAME, "A monthly budget your AI coding agent pays to the open source it uses"));
  const existing = await api.listPlans(product.id);
  const planIds = {} as Record<TierKey, string>;
  for (const t of TIERS) {
    const found = existing.find((p) => p.name === planName(t.cents) && p.status === "ACTIVE");
    planIds[t.key] = found ? found.id : (await api.createPlan(product.id, planName(t.cents), t.cents)).id;
  }
  return { productId: product.id, planIds, envLines: TIERS.map((t) => `${ENV_NAMES[t.key]}=${planIds[t.key]}`) };
}
