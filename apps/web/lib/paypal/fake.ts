import type { PayPalApi, PaypalOrder, PaypalSubscription, PaypalSubscriptionTxn, WebhookVerification } from "./api";
import { PayPalError } from "./client";
import { fromCents } from "./money";

/** In-memory stand-in for PayPal, used by tests. Mirrors the response shapes the real API returns. */
export class FakePayPal implements PayPalApi {
  calls: string[] = [];
  signatureValid = true;
  products = new Map<string, { id: string; name: string }>();
  plans = new Map<string, { id: string; name: string; status: string; productId: string; cents: number }>();
  subscriptions = new Map<string, PaypalSubscription & { transactions: PaypalSubscriptionTxn[] }>();
  orders = new Map<string, PaypalOrder & { cents: number; approvedBy: string | null }>();
  private failures = new Map<string, Error>();
  private seq = 0;

  private next(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  private enter(method: string): void {
    this.calls.push(method);
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  /** Make the next call to `method` throw `error`. */
  failNext(method: keyof PayPalApi, error: Error): void {
    this.failures.set(method, error);
  }

  async findProductByName(name: string) {
    this.enter("findProductByName");
    return [...this.products.values()].find((p) => p.name === name) ?? null;
  }

  async createProduct(name: string) {
    this.enter("createProduct");
    const p = { id: this.next("PROD-"), name };
    this.products.set(p.id, p);
    return { id: p.id };
  }

  async listPlans(productId: string) {
    this.enter("listPlans");
    return [...this.plans.values()].filter((p) => p.productId === productId).map(({ id, name, status }) => ({ id, name, status }));
  }

  async createPlan(productId: string, name: string, monthlyCents: number) {
    this.enter("createPlan");
    const p = { id: this.next("P-"), name, status: "ACTIVE", productId, cents: monthlyCents };
    this.plans.set(p.id, p);
    return { id: p.id };
  }

  async createSubscription(planId: string, customId: string) {
    this.enter("createSubscription");
    const s = { id: this.next("I-"), status: "APPROVAL_PENDING", plan_id: planId, custom_id: customId, transactions: [] };
    this.subscriptions.set(s.id, s);
    return { id: s.id, status: s.status, plan_id: planId, custom_id: customId };
  }

  /** The buyer approves in the PayPal popup; PayPal activates and takes the first payment. */
  approveSubscription(id: string, payerId: string, firstNetCents = 453): void {
    const s = this.subscriptions.get(id)!;
    s.status = "ACTIVE";
    s.start_time = "2026-10-14T10:00:00Z";
    s.subscriber = { payer_id: payerId };
    this.addSubscriptionPayment(id, this.next("SALE-"), firstNetCents);
  }

  addSubscriptionPayment(id: string, txnId: string, netCents: number, status = "COMPLETED"): void {
    this.subscriptions.get(id)!.transactions.push({
      id: txnId,
      status,
      time: "2026-10-14T10:00:05Z",
      amount_with_breakdown: {
        gross_amount: { currency_code: "USD", value: fromCents(netCents + 47) },
        net_amount: { currency_code: "USD", value: fromCents(netCents) },
      },
    });
  }

  async getSubscription(id: string) {
    this.enter("getSubscription");
    const s = this.subscriptions.get(id);
    if (!s) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "subscription not found", null);
    const { transactions: _t, ...rest } = s;
    return rest;
  }

  async listSubscriptionTransactions(id: string) {
    this.enter("listSubscriptionTransactions");
    const s = this.subscriptions.get(id);
    // Like the real sandbox: listing transactions of a subscription that was never approved is a 404.
    if (!s || s.status === "APPROVAL_PENDING") throw new PayPalError(404, "INVALID_RESOURCE_ID", "The specified resource does not exist.", null);
    return [...s.transactions];
  }

  async createOrder(cents: number, customId: string) {
    this.enter("createOrder");
    const o = { id: this.next("ORDER-"), status: "CREATED", cents, approvedBy: null, purchase_units: [{ custom_id: customId }] };
    this.orders.set(o.id, o);
    return { id: o.id, status: o.status, purchase_units: o.purchase_units };
  }

  approveOrder(id: string, payerId: string): void {
    const o = this.orders.get(id)!;
    o.status = "APPROVED";
    o.approvedBy = payerId;
  }

  async getOrder(id: string) {
    this.enter("getOrder");
    const o = this.orders.get(id);
    if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "order not found", null);
    return { id: o.id, status: o.status, payer: o.approvedBy ? { payer_id: o.approvedBy } : undefined, purchase_units: o.purchase_units };
  }

  async captureOrder(id: string) {
    this.enter("captureOrder");
    const o = this.orders.get(id);
    if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "order not found", null);
    if (o.status === "COMPLETED") throw new PayPalError(422, "ORDER_ALREADY_CAPTURED", "Order already captured", null);
    if (o.status !== "APPROVED") throw new PayPalError(422, "ORDER_NOT_APPROVED", "Payer has not approved the order", null);
    o.status = "COMPLETED";
    const net = o.cents - Math.round(o.cents * 0.0349) - 49;
    o.purchase_units = [
      {
        custom_id: o.purchase_units?.[0]?.custom_id,
        payments: {
          captures: [
            {
              id: this.next("CAP-"),
              status: "COMPLETED",
              custom_id: o.purchase_units?.[0]?.custom_id,
              create_time: "2026-10-14T10:00:00Z",
              amount: { currency_code: "USD", value: fromCents(o.cents) },
              seller_receivable_breakdown: {
                gross_amount: { currency_code: "USD", value: fromCents(o.cents) },
                net_amount: { currency_code: "USD", value: fromCents(net) },
              },
            },
          ],
        },
      },
    ];
    return this.getOrder(id);
  }

  async verifyWebhookSignature(input: WebhookVerification) {
    this.enter("verifyWebhookSignature");
    return this.signatureValid && Boolean(input.headers["paypal-transmission-sig"]);
  }
}
