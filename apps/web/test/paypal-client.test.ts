import { describe, expect, it } from "vitest";
import { createPayPalApi } from "../lib/paypal/api";
import { createPayPalHttp, PayPalError } from "../lib/paypal/client";
import { fromCents, toCents } from "../lib/paypal/money";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const token = { status: 200, body: { access_token: "tok-1", expires_in: 3600 } };
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

describe("money", () => {
  it("converts PayPal decimal strings to integer cents and back", () => {
    expect(toCents("4.53")).toBe(453);
    expect(toCents("10")).toBe(1000);
    expect(toCents("0.5")).toBe(50);
    expect(fromCents(453)).toBe("4.53");
    expect(fromCents(5)).toBe("0.05");
    expect(() => toCents("-1.00")).toThrow();
    expect(() => toCents("1.234")).toThrow();
    expect(() => fromCents(1.5)).toThrow();
  });
});

describe("createPayPalHttp", () => {
  it("logs in once, reuses the token, and sends a request id on POST", async () => {
    const f = fakeFetch([token, { status: 200, body: { id: "A" } }, { status: 200, body: { id: "B" } }]);
    const http = createPayPalHttp({ clientId: "id", clientSecret: "secret", baseUrl: "https://api.test", fetchImpl: f.impl });
    await http.request("GET", "/v1/a");
    await http.request("POST", "/v1/b", { x: 1 }, { requestId: "req-42" });
    expect(f.calls.map((c) => c.url)).toEqual(["https://api.test/v1/oauth2/token", "https://api.test/v1/a", "https://api.test/v1/b"]);
    expect(header(f.calls[0]!, "authorization")).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(header(f.calls[1]!, "authorization")).toBe("Bearer tok-1");
    expect(header(f.calls[1]!, "paypal-request-id")).toBeNull();
    expect(header(f.calls[2]!, "paypal-request-id")).toBe("req-42");
  });

  it("logs in again after the token expires", async () => {
    let t = 0;
    const f = fakeFetch([token, { status: 200, body: {} }, { status: 200, body: { access_token: "tok-2", expires_in: 3600 } }, { status: 200, body: {} }]);
    const http = createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: f.impl, now: () => t });
    await http.request("GET", "/v1/a");
    t = 3600_000;
    await http.request("GET", "/v1/a");
    expect(header(f.calls[3]!, "authorization")).toBe("Bearer tok-2");
  });

  it("raises PayPalError with the issue code PayPal reports", async () => {
    const f = fakeFetch([token, { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "Order already captured", debug_id: "dbg1", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } }]);
    const http = createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: f.impl });
    const err = await http.request("POST", "/v2/checkout/orders/X/capture", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 422, code: "ORDER_ALREADY_CAPTURED", debugId: "dbg1" });
  });

  it("fails clearly when PayPal login is refused", async () => {
    const f = fakeFetch([{ status: 401, body: { error: "invalid_client", error_description: "Client Authentication failed" } }]);
    const http = createPayPalHttp({ clientId: "id", clientSecret: "bad", baseUrl: "https://api.test", fetchImpl: f.impl });
    await expect(http.request("GET", "/v1/a")).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_FAILURE" });
  });

  it("turns a timeout or a dropped connection into a PayPalError, so callers can answer clearly", async () => {
    const timingOut = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;
    const slow = createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: timingOut });
    const timeout = await slow.request("GET", "/v1/a").catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(PayPalError);
    expect(timeout).toMatchObject({ status: 504, code: "TIMEOUT" });

    let calls = 0;
    const dropping = (async () => {
      if (calls++ === 0) return new Response(JSON.stringify(token.body), { status: 200 });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const flaky = createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: dropping });
    const dropped = await flaky.request("POST", "/v2/checkout/orders/X/capture", {}).catch((e: unknown) => e);
    expect(dropped).toBeInstanceOf(PayPalError);
    expect(dropped).toMatchObject({ status: 502, code: "NETWORK_ERROR" });
  });
});

describe("createPayPalApi", () => {
  it("builds the subscription, order and webhook-verification requests PayPal expects", async () => {
    const f = fakeFetch([
      token,
      { status: 201, body: { id: "I-SUB", status: "APPROVAL_PENDING", plan_id: "P-1" } },
      { status: 201, body: { id: "ORDER1", status: "CREATED" } },
      { status: 200, body: { verification_status: "SUCCESS" } },
      { status: 200, body: { transactions: [{ id: "S1", status: "COMPLETED" }] } },
    ]);
    const api = createPayPalApi(createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: f.impl }));
    await api.createSubscription("P-1", "acct-1");
    await api.createOrder(1000, "acct-1", "Top-up");
    const ok = await api.verifyWebhookSignature({
      headers: { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://c", "paypal-transmission-id": "t1", "paypal-transmission-sig": "sig", "paypal-transmission-time": "2026-10-14T00:00:00Z" },
      webhookId: "WH-1",
      event: { id: "E1" },
    });
    const txns = await api.listSubscriptionTransactions("I-SUB", "2026-10-01T00:00:00.000Z", "2026-10-14T00:00:00.000Z");
    expect(ok).toBe(true);
    expect(txns).toEqual([{ id: "S1", status: "COMPLETED" }]);
    const bodies = f.calls.slice(1).map((c) => (c.init.body ? JSON.parse(String(c.init.body)) : null));
    expect(bodies[0]).toMatchObject({ plan_id: "P-1", custom_id: "acct-1" });
    expect(bodies[1]).toMatchObject({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" }, custom_id: "acct-1" }] });
    expect(bodies[2]).toMatchObject({ auth_algo: "SHA256withRSA", transmission_id: "t1", webhook_id: "WH-1", webhook_event: { id: "E1" } });
    expect(f.calls[4]!.url).toBe("https://api.test/v1/billing/subscriptions/I-SUB/transactions?start_time=2026-10-01T00%3A00%3A00.000Z&end_time=2026-10-14T00%3A00%3A00.000Z");
  });

  it("builds the Payouts requests PayPal expects, paying verified PayPal accounts by id", async () => {
    const f = fakeFetch([
      token,
      { status: 201, body: { batch_header: { payout_batch_id: "B-1", batch_status: "PENDING", sender_batch_header: { sender_batch_id: "settle-1" } } } },
      { status: 200, body: { batch_header: { payout_batch_id: "B-1", batch_status: "SUCCESS" }, items: [{ payout_item_id: "PI-1", transaction_status: "SUCCESS" }] } },
    ]);
    const api = createPayPalApi(createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: f.impl }));
    const sent = await api.createPayoutBatch("settle-1", [{ senderItemId: "line-1", payerId: "PAYER-A", cents: 540, note: "For your work on fastapi" }]);
    const got = await api.getPayoutBatch("B-1");
    expect(sent.batch_header.payout_batch_id).toBe("B-1");
    expect(got.items?.[0]?.transaction_status).toBe("SUCCESS");
    expect(JSON.parse(String(f.calls[1]!.init.body))).toMatchObject({
      sender_batch_header: { sender_batch_id: "settle-1" },
      items: [{ recipient_type: "PAYPAL_ID", receiver: "PAYER-A", amount: { value: "5.40", currency: "USD" }, sender_item_id: "line-1", note: "For your work on fastapi" }],
    });
    expect(f.calls[1]!.url).toBe("https://api.test/v1/payments/payouts");
    expect(f.calls[2]!.url).toBe("https://api.test/v1/payments/payouts/B-1?page_size=1000");
  });

  it("treats missing webhook headers as a failed verification without calling PayPal", async () => {
    const f = fakeFetch([]);
    const api = createPayPalApi(createPayPalHttp({ clientId: "id", clientSecret: "s", baseUrl: "https://api.test", fetchImpl: f.impl }));
    expect(await api.verifyWebhookSignature({ headers: { "paypal-auth-algo": null }, webhookId: "WH-1", event: {} })).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
