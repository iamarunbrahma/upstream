"use client";

import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { call, type Me, type ReceiptView } from "./api";
import type { SettleNowOutcome } from "@/lib/demo/settle-now";
import type { DashboardTab } from "./Dashboard";

interface Step {
  done: boolean;
  title: string;
  body: string;
  action: React.ReactNode;
  /** Shown even once done: settling again after adding more money is part of the demo. */
  always?: boolean;
}

/** The sandbox demo in four steps, each with its own button, ticked off as the account moves along. */
export function DemoGuide(props: { me: Me; receipts: ReceiptView[]; onChange: () => Promise<void>; onShow: (tab: DashboardTab) => void }) {
  const { me } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const sample = props.receipts.find((r) => r.sessionId.startsWith("sample:"));

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
      await props.onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const spinner = (name: string) => busy === name && <Loader2 className="animate-spin" />;

  const steps: Step[] = [
    {
      done: me.balanceCents > 0 || me.givenCents > 0,
      title: "Add money with PayPal",
      body: "Pick a monthly budget or add money once. Sign in with the sandbox PayPal login from the testing notes.",
      action: (
        <Button variant="outline" size="sm" onClick={() => props.onShow("fund")}>
          Open PayPal
        </Button>
      ),
    },
    {
      done: Boolean(sample),
      title: "Run a sample session",
      body: "A recorded Claude Code session goes through the real pipeline: package lookups, then the Gemini judge.",
      action: (
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void run("sample", async () => {
              await call("POST", "/api/demo/sample-session");
              props.onShow("receipts");
              toast.success("The receipt is ready. Read why each package got its share.");
            })
          }
        >
          {spinner("sample")}
          {busy === "sample" ? "The AI is weighing it" : "Run a sample session"}
        </Button>
      ),
    },
    {
      done: sample?.status === "approved",
      title: "Approve its receipt",
      body: "Check the AI's reasons for each package below, then approve the receipt.",
      action: sample?.status === "proposed" && (
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => void run("approve", () => call("POST", `/api/receipts/${sample.id}/decision`, { action: "approve" }).then(() => undefined))}
        >
          {spinner("approve")}
          Approve it
        </Button>
      ),
    },
    {
      done: me.givenCents > 0,
      always: true,
      title: "Settle now",
      body: "Splits your budget across each package's maintainers and sends PayPal Payouts to the ones who have joined. In this demo, payouts go out at any amount; the real service waits until someone is owed $1.",
      action: (
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void run("settle", async () => {
              const { outcome, summary } = await call<{ outcome: SettleNowOutcome; summary: string[] }>("POST", "/api/demo/settle");
              const description = summary.join(" ");
              if (outcome === "settled") {
                props.onShow("money");
                toast.success("Settled", { description });
              } else if (outcome === "nothing") toast.info("Nothing new to settle", { description: "Approve another receipt, or add money, and settle again." });
              else toast.warning(outcome === "waiting" ? "Not settled yet" : "Nothing set aside", { description });
            })
          }
        >
          {spinner("settle")}
          Settle now
        </Button>
      ),
    },
  ];
  const done = steps.filter((s) => s.done).length;

  return (
    <Card className="border-primary/20 bg-gradient-to-b from-accent/60 to-background shadow-sm">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-lg font-semibold">Try the whole flow in four steps</CardTitle>
            <CardDescription>Your own demo account. Nothing here is real money: it all runs on the PayPal sandbox.</CardDescription>
          </div>
          <div className="flex min-w-40 items-center gap-3 text-sm text-muted-foreground">
            <Progress value={(done / steps.length) * 100} className="h-2" aria-label={`${done} of ${steps.length} steps done`} />
            <span className="tabular-nums">
              {done}/{steps.length}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-3 md:grid-cols-2">
          {steps.map((s, i) => (
            <li key={s.title} className={cn("flex gap-3 rounded-xl border bg-background/80 p-4", s.done && "border-primary/25")}>
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                  s.done ? "border-primary bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                )}
                aria-hidden
              >
                {s.done ? <Check className="size-3.5" /> : i + 1}
              </span>
              <div className="grid flex-1 content-start gap-1.5">
                <div className="font-medium">
                  {s.title}
                  {s.done && <span className="sr-only"> (done)</span>}
                </div>
                <p className="text-sm text-muted-foreground">{s.body}</p>
                {(!s.done || s.always) && s.action && <div className="pt-1">{s.action}</div>}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
