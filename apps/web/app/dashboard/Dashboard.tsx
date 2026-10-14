"use client";

import { HandCoins, ReceiptText, Wallet } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatUsd } from "@/lib/format";
import { call, type Me, type ReceiptView } from "./api";
import { DemoGuide } from "./DemoGuide";
import { FundingPanel } from "./FundingPanel";
import { Given, Projection } from "./Money";
import { Receipts } from "./Receipts";

/** While a payout is on its way, check every 5 seconds for 3 minutes; PayPal's webhook updates it on the server. */
const POLL_MS = 5_000;
const POLL_TRIES = 36;

export type DashboardTab = "receipts" | "money" | "fund";

function Stat(props: { icon: typeof Wallet; label: string; value: string; note: string; accent?: boolean }) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardDescription className="font-medium">{props.label}</CardDescription>
        <CardAction>
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-foreground">
            <props.icon className="size-4" />
          </span>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-semibold tracking-tight tabular-nums ${props.accent ? "text-primary" : ""}`}>{props.value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{props.note}</p>
      </CardContent>
    </Card>
  );
}

export function Dashboard(props: { clientId: string; environment: "sandbox" | "production"; tiers: { key: string; label: string }[] }) {
  const [me, setMe] = useState<Me | null>(null);
  const [receipts, setReceipts] = useState<ReceiptView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);
  const [tab, setTab] = useState<DashboardTab>("receipts");

  const refresh = useCallback(async () => {
    try {
      const [next, list] = await Promise.all([call<Me>("GET", "/api/me"), call<{ receipts: ReceiptView[] }>("GET", "/api/receipts?limit=20")]);
      setMe(next);
      setReceipts(list.receipts);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onItsWay = me?.given.some((g) => g.state === "on-its-way") ?? false;
  useEffect(() => {
    if (!onItsWay || polls >= POLL_TRIES) return;
    const t = setTimeout(() => {
      setPolls((n) => n + 1);
      void refresh();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [onItsWay, polls, refresh]);
  const changed = useCallback(async () => {
    setPolls(0);
    await refresh();
  }, [refresh]);

  if (!me && error) {
    return (
      <Card className="mx-auto max-w-lg text-center shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">{error}</CardTitle>
          <CardDescription>
            Open your dashboard from the terminal with <code className="font-mono">upstream dashboard</code>, or{" "}
            <Link href="/" className="font-medium text-primary underline-offset-4 hover:underline">
              try the demo
            </Link>
            .
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!me) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const waiting = receipts.filter((r) => r.status === "proposed").length;
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Your budget</h1>
          <p className="mt-1 text-muted-foreground">What your agents used, what you approved, and where the money went.</p>
        </div>
        {me.demo && (
          <Badge variant="outline" className="gap-1.5 rounded-full px-3 py-1">
            <span className="size-1.5 rounded-full bg-primary" /> Sandbox demo account
          </Badge>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat icon={Wallet} label="In your budget" value={formatUsd(me.balanceCents)} note="Spent at the next settlement" />
        <Stat icon={HandCoins} label="Set aside for maintainers" value={formatUsd(me.givenCents)} note="Paid out, on its way, or waiting for them" accent />
        <Stat icon={ReceiptText} label="Receipts waiting for you" value={String(waiting)} note={`${me.receipts.approved} approved so far`} />
      </div>

      {me.demo && <DemoGuide me={me} receipts={receipts} onChange={changed} onShow={setTab} />}

      <Tabs value={tab} onValueChange={(v) => setTab(v as DashboardTab)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="receipts">
              Receipts
              {waiting > 0 && (
                <Badge className="ml-1 h-5 min-w-5 rounded-full px-1.5 text-[11px]" aria-label={`${waiting} waiting`}>
                  {waiting}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="money">Where the money goes</TabsTrigger>
            <TabsTrigger value="fund">Add money</TabsTrigger>
          </TabsList>
          <label className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <Switch
              checked={me.autoApprove}
              onCheckedChange={async (checked) => {
                await call("PATCH", "/api/settings", { autoApprove: checked });
                await refresh();
              }}
            />
            Approve automatically while I have money
          </label>
        </div>
        <TabsContent value="receipts" className="mt-4">
          <Receipts receipts={receipts} onChange={changed} />
        </TabsContent>
        <TabsContent value="money" className="mt-4 grid gap-4">
          <Projection shares={me.projection} />
          <Given lines={me.given} />
          {me.projection.length === 0 && me.given.length === 0 && (
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Nothing here yet</CardTitle>
                <CardDescription>Approve a receipt and add money, and you&apos;ll see how your budget would be split, then where it went.</CardDescription>
              </CardHeader>
            </Card>
          )}
        </TabsContent>
        {/* Kept mounted, so a PayPal payment in progress survives switching tabs. */}
        <TabsContent value="fund" forceMount className="mt-4 data-[state=inactive]:hidden">
          <FundingPanel me={me} refresh={refresh} clientId={props.clientId} environment={props.environment} tiers={props.tiers} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
