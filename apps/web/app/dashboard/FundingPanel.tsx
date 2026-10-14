"use client";

import { PayPalOneTimePaymentButton, PayPalProvider, PayPalSubscriptionButton } from "@paypal/react-paypal-js/sdk-v6";
import { useCallback, useEffect, useState } from "react";
import { formatUsd } from "../../lib/format";
import { recordPayment } from "./record-payment";

interface Me {
  balanceCents: number;
  subscription: { id: string; tier: string; status: string } | null;
  autoApprove: boolean;
  receipts: { proposed: number; approved: number; skipped: number };
  paymentsReady: boolean;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Something went wrong (${res.status})`);
  return data;
}

export function FundingPanel(props: { clientId: string; environment: "sandbox" | "production"; tiers: { key: string; label: string }[] }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [topupCents, setTopupCents] = useState(1000);
  const [pending, setPending] = useState<{ message: string; retry: () => void } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await call<Me>("GET", "/api/me"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Records a payment PayPal has approved. If that can't finish yet, offers "Check again", which repeats it safely. */
  async function settle(record: () => Promise<{ credited: number }>, tries: number, notYet: string): Promise<void> {
    setError(null);
    setPending(null);
    setNotice("Recording your payment...");
    const r = await recordPayment(
      async () => {
        const answer = await record();
        await refresh();
        return answer;
      },
      { tries, waitMs: 10_000 },
    );
    if (r && r.credited > 0) {
      setNotice(`Thanks. ${formatUsd(r.credited)} was added to your budget.`);
      return;
    }
    setNotice(null);
    setPending({ message: r ? notYet : "PayPal has your payment, but we couldn't record it yet.", retry: () => void settle(record, 1, notYet) });
  }

  if (!me && error) {
    return (
      <p>
        {error}. Open your dashboard from the terminal with <code>upstream dashboard</code>.
      </p>
    );
  }
  if (!me) return <p>Loading your budget...</p>;

  const activeTier = me.subscription?.status === "ACTIVE" ? props.tiers.find((t) => t.key === me.subscription!.tier) : undefined;

  return (
    <div>
      <p style={{ fontSize: 32, margin: "8px 0" }}>
        {formatUsd(me.balanceCents)} <span style={{ fontSize: 16, color: "#555" }}>in your budget</span>
      </p>
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <p role="status">
          {pending.message}{" "}
          <button type="button" onClick={pending.retry}>
            Check again
          </button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}

      {!me.paymentsReady ? (
        <p>Payments aren&apos;t set up on this server yet.</p>
      ) : (
        <PayPalProvider clientId={props.clientId} environment={props.environment} components={["paypal-payments", "paypal-subscriptions"]} pageType="checkout">
          <h2>Monthly budget</h2>
          {activeTier ? (
            <p>You give {activeTier.label}. Thank you.</p>
          ) : (
            props.tiers.map((t) => (
              <div key={t.key} style={{ margin: "12px 0" }}>
                <p>{t.label}</p>
                <PayPalSubscriptionButton
                  createSubscription={async () => ({
                    subscriptionId: (await call<{ subscriptionId: string }>("POST", "/api/subscriptions", { tier: t.key })).subscriptionId,
                  })}
                  onApprove={async ({ subscriptionId }) => {
                    void settle(() => call<{ credited: number }>("POST", `/api/subscriptions/${subscriptionId}/reconcile`), 12, "Thanks. Your first payment will show up here soon.");
                  }}
                  onError={() => setError("PayPal couldn't start the subscription. Please try again.")}
                />
              </div>
            ))
          )}

          <h2>Add money once</h2>
          <select value={topupCents} onChange={(e) => setTopupCents(Number(e.target.value))} aria-label="Amount to add">
            {[500, 1000, 2500].map((c) => (
              <option key={c} value={c}>
                {formatUsd(c)}
              </option>
            ))}
          </select>
          <PayPalOneTimePaymentButton
            createOrder={async () => ({ orderId: (await call<{ orderId: string }>("POST", "/api/topups", { cents: topupCents })).orderId })}
            onApprove={async ({ orderId }) => {
              void settle(() => call<{ credited: number }>("POST", `/api/topups/${orderId}/capture`), 3, "Thanks. PayPal is still processing this payment.");
            }}
            onError={() => setError("PayPal couldn't take the payment. Please try again.")}
          />
        </PayPalProvider>
      )}

      <h2>Receipts</h2>
      <label>
        <input
          type="checkbox"
          checked={me.autoApprove}
          onChange={async (e) => {
            await call("PATCH", "/api/settings", { autoApprove: e.target.checked });
            await refresh();
          }}
        />{" "}
        Approve my receipts automatically while I have money in my budget
      </label>
      <p>
        {me.receipts.proposed} waiting for you, {me.receipts.approved} approved.
      </p>
    </div>
  );
}
