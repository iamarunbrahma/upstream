"use client";

import { CircleCheck, Clock, HandCoins, LogOut, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatUsd } from "@/lib/format";
import type { MaintainerSummary } from "@/lib/maintainers/summary";

const PAYPAL_NOTICE: Record<string, string> = {
  linked: "PayPal is linked.",
  unchanged: "That PayPal account was already linked.",
  "not-verified": "PayPal says that account isn't verified yet. Verify it with PayPal, then link it again.",
  "in-use": "That PayPal account is already linked to another maintainer.",
  cancelled: "You didn't finish linking PayPal.",
};

const ROLE: Record<string, string> = {
  foundation: "built on it",
  feature: "used it for a feature",
  helper: "used it as a helper",
  tooling: "used it as a tool",
};

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

export function MaintainerPanel() {
  const [me, setMe] = useState<MaintainerSummary | null | "signed-out">(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const paypal = new URLSearchParams(window.location.search).get("paypal");
    if (paypal && PAYPAL_NOTICE[paypal]) setNotice(PAYPAL_NOTICE[paypal]);
    fetch("/api/maintainer/me")
      .then(async (res) => setMe(res.status === 401 ? "signed-out" : ((await res.json()) as MaintainerSummary)))
      .catch(() => setMe("signed-out"));
  }, []);

  if (me === null) return <Skeleton className="h-48 rounded-xl" />;
  if (me === "signed-out") {
    return (
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">See what agents have set aside for you</CardTitle>
          <CardDescription className="leading-relaxed">
            When a developer&apos;s AI coding agent builds with your package, they can choose to pay you for it through Upstream. Sign in with GitHub
            to see what&apos;s waiting for you, then link PayPal to be paid.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild size="lg">
            <a href="/maintainer/github/start">Sign in with GitHub</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const stats = [
    { icon: Clock, label: "Waiting for you", cents: me.cents.waiting },
    { icon: Wallet, label: "On its way", cents: me.cents.onItsWay },
    { icon: HandCoins, label: "Paid", cents: me.cents.paid, accent: true },
  ];
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar className="size-10">
            <AvatarImage src={`https://github.com/${me.login}.png?size=80`} alt="" />
            <AvatarFallback>{me.login.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div>
            <div className="font-semibold">@{me.login}</div>
            <div className="text-sm text-muted-foreground">Signed in with GitHub</div>
          </div>
        </div>
        <form method="post" action="/maintainer/signout">
          <Button type="submit" variant="outline" size="sm">
            <LogOut /> Sign out
          </Button>
        </form>
      </div>
      {notice && (
        <Alert>
          <CircleCheck />
          <AlertDescription role="status">{notice}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((st) => (
          <Card key={st.label} className="shadow-sm">
            <CardHeader>
              <CardDescription className="font-medium">{st.label}</CardDescription>
              <CardAction>
                <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-foreground">
                  <st.icon className="size-4" />
                </span>
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-semibold tracking-tight tabular-nums ${st.accent ? "text-primary" : ""}`}>{formatUsd(st.cents)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Where we pay you</CardTitle>
          <CardDescription>
            {me.paypal.linked
              ? me.paypal.firstPayoutFrom
                ? `PayPal is linked. Your first payout can go out from ${me.paypal.firstPayoutFrom}.`
                : "PayPal is linked. Payouts go out with each settlement."
              : "Link a verified PayPal account so we can pay you. Payouts start a week after you link it."}
          </CardDescription>
          <CardAction>
            {me.paypal.linked ? <Badge>PayPal linked</Badge> : <Badge variant="outline">Not linked yet</Badge>}
          </CardAction>
        </CardHeader>
        <CardContent>
          <Button asChild variant={me.paypal.linked ? "outline" : "default"}>
            <a href="/maintainer/paypal/start">{me.paypal.linked ? "Link a different PayPal account" : "Link PayPal"}</a>
          </Button>
        </CardContent>
      </Card>

      {me.packages.length > 0 && (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold">How agents use your packages</CardTitle>
            <CardDescription>Counted over every receipt that names them. No developer is identified.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Package</TableHead>
                  <TableHead>What agents did with it</TableHead>
                  <TableHead className="text-right">Set aside</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {me.packages.map((p) => (
                  <TableRow key={`${p.ecosystem}:${p.name}`}>
                    <TableCell className="font-medium">
                      {p.name} <span className="text-xs font-normal text-muted-foreground">{p.ecosystem}</span>
                    </TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">
                      {Object.entries(p.roles)
                        .map(([role, n]) => `${ROLE[role] ?? role} ${times(n)}`)
                        .join(", ") || "no details yet"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatUsd(p.cents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {(me.months.length > 0 || me.payouts.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {me.months.length > 0 && (
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="text-base font-semibold">By month</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    {me.months.map((m) => (
                      <TableRow key={m.month}>
                        <TableCell>{m.month}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatUsd(m.setAsideCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
          {me.payouts.length > 0 && (
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="text-base font-semibold">Payouts</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    {me.payouts.map((p, i) => (
                      <TableRow key={i}>
                        <TableCell>{p.date}</TableCell>
                        <TableCell className="tabular-nums">{formatUsd(p.cents)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={p.status === "SUCCESS" ? "default" : "outline"}>
                            {p.status === "SUCCESS" ? "Paid" : p.status === "PENDING" ? "On its way" : p.status.toLowerCase()}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
