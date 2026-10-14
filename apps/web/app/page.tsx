import { ArrowRight, BadgeCheck, CircleCheck, Code, HandCoins, Plug, ReceiptText, Scale, ShieldCheck, Sparkles, Terminal, Wallet } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { demoEnabled } from "@/lib/demo/accounts";
import { getDeps } from "@/lib/deps";
import { formatUsd } from "@/lib/format";
import { indexRows, type UsageIndex } from "@/lib/index/usage";
import usage from "@/lib/index/usage.json" with { type: "json" };
import { UsageChart } from "./ui/UsageChart";

export const dynamic = "force-dynamic";

const FLOW = [
  { icon: Terminal, title: "Your agent codes", body: "A Claude Code session installs and imports packages." },
  { icon: Sparkles, title: "AI weighs the work", body: "Gemini judges how much each package mattered." },
  { icon: HandCoins, title: "Maintainers get paid", body: "Your budget goes out through PayPal Payouts." },
];

const STEPS = [
  { icon: Plug, title: "Install once", body: "A Claude Code plugin links your machine to your Upstream account." },
  { icon: Wallet, title: "Set a budget", body: "Give $5, $15 or $50 a month with PayPal, or add money once." },
  { icon: Code, title: "Code as usual", body: "When a session ends, the plugin writes a receipt on your machine. Only package names and counts leave it, never your code." },
  { icon: Scale, title: "AI weighs the work", body: "Gemini judges how much the session depended on each package, inside fixed limits it can't break." },
  { icon: ReceiptText, title: "You approve", body: "Approve the receipt in your agent or here, or let a rule approve it while you have money in your budget." },
  { icon: HandCoins, title: "Maintainers get paid", body: "Your budget is split across your receipts and each package's maintainers, to the cent, and paid through PayPal." },
];

const SAFEGUARDS = [
  "No payout ever goes to a developer's own PayPal account.",
  "At most $100 a month from one developer to one maintainer.",
  "A new maintainer's first payout waits a week.",
  "Money nobody claims in 90 days goes back to the developer's budget.",
  "Money follows the GitHub account, so a renamed or reused username can't redirect it.",
];

export default async function Home() {
  const deps = await getDeps();
  const index = await indexRows(deps.db, usage as UsageIndex);
  const demo = demoEnabled();
  return (
    <main>
      <section className="relative overflow-hidden">
        <div aria-hidden className="bg-dots absolute inset-0 -z-10" />
        <div aria-hidden className="absolute inset-x-0 -top-40 -z-10 mx-auto h-80 max-w-3xl rounded-full bg-primary/15 blur-3xl" />
        <div className="mx-auto max-w-6xl px-4 pt-20 pb-6 text-center sm:pt-28">
          <Badge variant="outline" className="mb-6 gap-1.5 rounded-full bg-background/80 px-3 py-1 text-xs font-medium backdrop-blur">
            <span className="size-1.5 rounded-full bg-primary" /> PayPal AI Hackathon · runs on the PayPal sandbox
          </Badge>
          <h1 className="mx-auto max-w-4xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
            Your AI coding agent <span className="bg-gradient-to-r from-primary to-emerald-500 bg-clip-text text-transparent">pays back</span> the open
            source it builds with.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-pretty text-muted-foreground">
            Agents install, import and read open-source packages all day, but they never sponsor anyone. In January 2026, Tailwind Labs laid off 75% of
            its engineers after AI tools sent people around the docs that used to sell its paid product.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            {demo && (
              <form method="post" action="/demo/start">
                <Button type="submit" size="lg" className="h-11 px-6 text-base shadow-md shadow-primary/25">
                  Try the demo <ArrowRight />
                </Button>
              </form>
            )}
            <Button asChild variant="outline" size="lg" className="h-11 px-6 text-base">
              <Link href="#how">How it works</Link>
            </Button>
          </div>
          <p className="mt-5 flex flex-wrap items-center justify-center gap-1.5 text-sm text-muted-foreground">
            Or install it in Claude Code: <code className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">npx upstream-pay init</code>
          </p>

          <div className="mx-auto mt-16 grid max-w-4xl gap-3 sm:grid-cols-3">
            {FLOW.map((f, i) => (
              <div key={f.title} className="relative rounded-2xl border bg-card/80 p-5 text-left shadow-sm backdrop-blur">
                <div className="mb-3 flex items-center justify-between">
                  <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground">
                    <f.icon className="size-4.5" />
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>
                </div>
                <div className="font-medium">{f.title}</div>
                <div className="mt-1 text-sm text-muted-foreground">{f.body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="index" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-12">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl font-semibold">Agent usage vs funding</CardTitle>
            <CardDescription className="max-w-2xl text-sm">
              The packages that did the most work in real Claude Code sessions, set against their share of the money Upstream has set aside so far.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UsageChart rows={index.rows} />
          </CardContent>
          <CardFooter className="border-t text-xs text-muted-foreground">
            Agent work: each package&apos;s average share of the work across {index.sessions} real Claude Code sessions, scored from what the agent installed,
            imported and wrote. Money: {formatUsd(index.fundedCents)} set aside on this sandbox so far.
          </CardFooter>
        </Card>
      </section>

      <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
          <p className="mt-3 text-muted-foreground">You stay in charge of every dollar. The agent can only propose a payment.</p>
        </div>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <Card className="h-full shadow-sm transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
                      <s.icon className="size-5" />
                    </span>
                    <Badge variant="secondary" className="font-mono">
                      Step {i + 1}
                    </Badge>
                  </div>
                  <CardTitle className="text-base font-semibold">{s.title}</CardTitle>
                  <CardDescription className="leading-relaxed">{s.body}</CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 pt-16 lg:grid-cols-5">
        <Card className="shadow-sm lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-semibold">
              <ShieldCheck className="size-5 text-primary" /> Safeguards built in
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3 text-sm">
              {SAFEGUARDS.map((s) => (
                <li key={s} className="flex gap-3">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                  {s}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-br from-accent to-background shadow-sm lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-semibold">
              <BadgeCheck className="size-5 text-primary" /> Maintain open source?
            </CardTitle>
            <CardDescription className="leading-relaxed">
              Sign in with GitHub to see what developers&apos; agents have set aside for you, then link PayPal to be paid. There&apos;s nothing else to do.
            </CardDescription>
          </CardHeader>
          <CardFooter className="mt-auto bg-transparent">
            <Button asChild>
              <Link href="/maintainer">
                Get paid for your packages <ArrowRight />
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </section>
    </main>
  );
}
