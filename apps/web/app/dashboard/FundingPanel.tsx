"use client";

import { PayPalOneTimePaymentButton, PayPalProvider, PayPalSubscriptionButton } from "@paypal/react-paypal-js/sdk-v6";
import { CircleAlert, CircleCheck, Clock, Repeat, Wallet } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatUsd } from "@/lib/format";
import { call, type Me } from "./api";
import { recordPayment } from "./record-payment";

export function FundingPanel(props: {
  me: Me;
  refresh: () => Promise<void>;
  clientId: string;
  environment: "sandbox" | "production";
  tiers: { key: string; label: string }[];
}) {
  const { me, refresh } = props;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [topupCents, setTopupCents] = useState(1000);
  const [tierKey, setTierKey] = useState(props.tiers[0]?.key ?? "");
  const [pending, setPending] = useState<{ message: string; retry: () => void } | null>(null);

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

  const activeTier = me.subscription?.status === "ACTIVE" ? props.tiers.find((t) => t.key === me.subscription!.tier) : undefined;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base font-semibold">Add money to your budget</CardTitle>
        <CardDescription>Pay with PayPal. On the demo, sign in with the sandbox PayPal login from the testing notes.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {notice && (
          <Alert>
            <CircleCheck />
            <AlertDescription role="status">{notice}</AlertDescription>
          </Alert>
        )}
        {pending && (
          <Alert>
            <Clock />
            <AlertDescription role="status" className="flex flex-wrap items-center gap-3">
              {pending.message}
              <Button size="sm" variant="outline" onClick={pending.retry}>
                Check again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription role="alert">{error}</AlertDescription>
          </Alert>
        )}

        {!me.paymentsReady ? (
          <p className="text-sm text-muted-foreground">Payments aren&apos;t set up on this server yet.</p>
        ) : (
          <PayPalProvider clientId={props.clientId} environment={props.environment} components={["paypal-payments", "paypal-subscriptions"]} pageType="checkout">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border p-4">
                <div className="mb-3 flex items-center gap-2 font-medium">
                  <Repeat className="size-4 text-primary" /> Every month
                </div>
                {activeTier ? (
                  <p className="text-sm">
                    You give <strong>{activeTier.label}</strong>. Thank you.
                  </p>
                ) : (
                  <div className="grid gap-3">
                    <Select value={tierKey} onValueChange={setTierKey}>
                      <SelectTrigger className="w-full" aria-label="Monthly amount">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {props.tiers.map((t) => (
                          <SelectItem key={t.key} value={t.key}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <PayPalSubscriptionButton
                      createSubscription={async () => ({
                        subscriptionId: (await call<{ subscriptionId: string }>("POST", "/api/subscriptions", { tier: tierKey })).subscriptionId,
                      })}
                      onApprove={async ({ subscriptionId }) => {
                        void settle(() => call<{ credited: number }>("POST", `/api/subscriptions/${subscriptionId}/reconcile`), 12, "Thanks. Your first payment will show up here soon.");
                      }}
                      onError={() => setError("PayPal couldn't start the subscription. Please try again.")}
                    />
                  </div>
                )}
              </div>
              <div className="rounded-xl border p-4">
                <div className="mb-3 flex items-center gap-2 font-medium">
                  <Wallet className="size-4 text-primary" /> Once
                </div>
                <div className="grid gap-3">
                  <Select value={String(topupCents)} onValueChange={(v) => setTopupCents(Number(v))}>
                    <SelectTrigger className="w-full" aria-label="Amount to add">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[500, 1000, 2500].map((c) => (
                        <SelectItem key={c} value={String(c)}>
                          {formatUsd(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <PayPalOneTimePaymentButton
                    createOrder={async () => ({ orderId: (await call<{ orderId: string }>("POST", "/api/topups", { cents: topupCents })).orderId })}
                    onApprove={async ({ orderId }) => {
                      void settle(() => call<{ credited: number }>("POST", `/api/topups/${orderId}/capture`), 3, "Thanks. PayPal is still processing this payment.");
                    }}
                    onError={() => setError("PayPal couldn't take the payment. Please try again.")}
                  />
                </div>
              </div>
            </div>
          </PayPalProvider>
        )}
      </CardContent>
    </Card>
  );
}
