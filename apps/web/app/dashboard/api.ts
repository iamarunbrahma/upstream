import type { ReceiptView } from "@upstream/core";
import type { GivenLine, ProjectedShare } from "../../lib/funding/view";

/** What GET /api/me answers. */
export interface Me {
  balanceCents: number;
  givenCents: number;
  subscription: { id: string; tier: string; status: string } | null;
  autoApprove: boolean;
  receipts: { proposed: number; approved: number; skipped: number };
  paymentsReady: boolean;
  demo: boolean;
  projection: ProjectedShare[];
  given: GivenLine[];
}

export type { ReceiptView };

/** A same-site JSON call to this server. Throws with the server's own words when it says no. */
export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Something went wrong (${res.status})`);
  return data;
}
