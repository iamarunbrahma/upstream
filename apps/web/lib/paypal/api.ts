import type { PayPalHttp } from "./client";
import { fromCents } from "./money";

export interface Money {
  currency_code: string;
  value: string;
}

export interface PaypalSubscription {
  id: string;
  status: string;
  plan_id?: string;
  custom_id?: string;
  start_time?: string;
  subscriber?: { payer_id?: string; email_address?: string };
}

export interface PaypalSubscriptionTxn {
  id: string;
  status: string;
  time?: string;
  amount_with_breakdown?: { gross_amount?: Money; net_amount?: Money };
}

export interface PaypalCapture {
  id: string;
  status: string;
  custom_id?: string;
  create_time?: string;
  amount?: Money;
  seller_receivable_breakdown?: { gross_amount?: Money; net_amount?: Money };
}

export interface PaypalOrder {
  id: string;
  status: string;
  payer?: { payer_id?: string };
  purchase_units?: Array<{ custom_id?: string; payments?: { captures?: PaypalCapture[] } }>;
}

export interface WebhookVerification {
  headers: Record<string, string | null>;
  webhookId: string;
  event: unknown;
}

export interface PayPalApi {
  findProductByName(name: string): Promise<{ id: string } | null>;
  createProduct(name: string, description: string): Promise<{ id: string }>;
  listPlans(productId: string): Promise<Array<{ id: string; name: string; status: string }>>;
  createPlan(productId: string, name: string, monthlyCents: number): Promise<{ id: string }>;
  createSubscription(planId: string, customId: string): Promise<PaypalSubscription>;
  getSubscription(id: string): Promise<PaypalSubscription>;
  listSubscriptionTransactions(id: string, startIso: string, endIso: string): Promise<PaypalSubscriptionTxn[]>;
  createOrder(cents: number, customId: string, description: string): Promise<PaypalOrder>;
  getOrder(id: string): Promise<PaypalOrder>;
  captureOrder(id: string): Promise<PaypalOrder>;
  verifyWebhookSignature(input: WebhookVerification): Promise<boolean>;
}

const WEBHOOK_HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"] as const;

export function createPayPalApi(http: PayPalHttp): PayPalApi {
  const id = (s: string) => encodeURIComponent(s);
  return {
    async findProductByName(name) {
      const res = await http.request<{ products?: Array<{ id: string; name: string }> }>("GET", "/v1/catalogs/products?page_size=20");
      return res.products?.find((p) => p.name === name) ?? null;
    },
    createProduct(name, description) {
      return http.request("POST", "/v1/catalogs/products", { name, description, type: "SERVICE", category: "SOFTWARE" });
    },
    async listPlans(productId) {
      const res = await http.request<{ plans?: Array<{ id: string; name: string; status: string }> }>(
        "GET",
        `/v1/billing/plans?product_id=${id(productId)}&page_size=20`,
      );
      return res.plans ?? [];
    },
    createPlan(productId, name, monthlyCents) {
      return http.request("POST", "/v1/billing/plans", {
        product_id: productId,
        name,
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: { interval_unit: "MONTH", interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: { fixed_price: { value: fromCents(monthlyCents), currency_code: "USD" } },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: "CONTINUE", payment_failure_threshold: 3 },
      });
    },
    createSubscription(planId, customId) {
      return http.request("POST", "/v1/billing/subscriptions", {
        plan_id: planId,
        custom_id: customId,
        application_context: { brand_name: "Upstream", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW" },
      });
    },
    getSubscription(subId) {
      return http.request("GET", `/v1/billing/subscriptions/${id(subId)}`);
    },
    async listSubscriptionTransactions(subId, startIso, endIso) {
      const q = `start_time=${encodeURIComponent(startIso)}&end_time=${encodeURIComponent(endIso)}`;
      const res = await http.request<{ transactions?: PaypalSubscriptionTxn[] }>("GET", `/v1/billing/subscriptions/${id(subId)}/transactions?${q}`);
      return res.transactions ?? [];
    },
    createOrder(cents, customId, description) {
      return http.request("POST", "/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: fromCents(cents) }, custom_id: customId, description }],
      });
    },
    getOrder(orderId) {
      return http.request("GET", `/v2/checkout/orders/${id(orderId)}`);
    },
    captureOrder(orderId) {
      return http.request("POST", `/v2/checkout/orders/${id(orderId)}/capture`, {});
    },
    async verifyWebhookSignature({ headers, webhookId, event }) {
      const h = Object.fromEntries(WEBHOOK_HEADERS.map((k) => [k, headers[k] ?? null]));
      if (WEBHOOK_HEADERS.some((k) => !h[k])) return false;
      const res = await http.request<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: h["paypal-auth-algo"],
        cert_url: h["paypal-cert-url"],
        transmission_id: h["paypal-transmission-id"],
        transmission_sig: h["paypal-transmission-sig"],
        transmission_time: h["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      });
      return res.verification_status === "SUCCESS";
    },
  };
}
