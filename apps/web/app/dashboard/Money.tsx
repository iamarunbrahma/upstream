"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatUsd } from "@/lib/format";
import { groupGiven } from "@/lib/funding/given-groups";
import type { GivenLine, GivenState, ProjectedShare } from "@/lib/funding/view";

/** Where one maintainer's share is now, in a few words. */
const STATE: Record<GivenState, { label: string; variant: "default" | "secondary" | "outline" }> = {
  waiting: { label: "Not joined yet", variant: "outline" },
  held: { label: "Joined, payout coming", variant: "secondary" },
  "on-its-way": { label: "On its way via PayPal", variant: "secondary" },
  paid: { label: "Paid via PayPal", variant: "default" },
  returned: { label: "Back in your budget", variant: "outline" },
};

function GithubAvatar(props: { login: string; size: string }) {
  return (
    <Avatar className={props.size}>
      <AvatarImage src={`https://github.com/${props.login}.png?size=64`} alt="" />
      <AvatarFallback className="text-[10px]">{props.login.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** "If we settled today": the whole budget split by the approved receipts, per package. */
export function Projection(props: { shares: ProjectedShare[] }) {
  if (props.shares.length === 0) return null;
  const max = Math.max(...props.shares.map((s) => s.cents));
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base font-semibold">If we settled today</CardTitle>
        <CardDescription>Your whole budget, split by the receipts you approved. Each package&apos;s share then goes to its maintainers.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {props.shares.map((s) => (
          <div key={`${s.ecosystem}:${s.name}`} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate font-medium">{s.name}</span>
            <Progress value={(s.cents / max) * 100} className="h-2" />
            <span className="w-16 text-right tabular-nums">{formatUsd(s.cents)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** "Where your money went": what settlements set aside, per package and maintainer, and where each share is now. */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function Given(props: { lines: GivenLine[] }) {
  if (props.lines.length === 0) return null;
  const { groups, people, packages, waitingCents } = groupGiven(props.lines);
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base font-semibold">Where your money went</CardTitle>
        <CardDescription>
          Split across {count(people, "maintainer", "maintainers")} of {count(packages, "package", "packages")}.
          {waitingCents > 0 &&
            ` ${formatUsd(waitingCents)} waits for maintainers who haven't joined Upstream yet. If nobody claims it in 90 days, it comes back to your budget.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple">
          {groups.map((p) => (
            <AccordionItem key={`${p.ecosystem}:${p.name}`} value={`${p.ecosystem}:${p.name}`}>
              <AccordionTrigger className="items-center hover:no-underline">
                <span className="flex flex-1 items-center gap-3 pr-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="flex -space-x-2">
                    {p.logins.slice(0, 4).map((login) => (
                      <span key={login} className="rounded-full ring-2 ring-background">
                        <GithubAvatar login={login} size="size-6" />
                      </span>
                    ))}
                  </span>
                  <span className="hidden text-xs font-normal text-muted-foreground sm:inline">{count(p.logins.length, "maintainer", "maintainers")}</span>
                  {p.paid > 0 ? (
                    <Badge className="text-[11px]">{p.paid} paid</Badge>
                  ) : (
                    p.onItsWay > 0 && (
                      <Badge variant="secondary" className="text-[11px]">
                        On its way
                      </Badge>
                    )
                  )}
                  <span className="ml-auto font-semibold tabular-nums">{formatUsd(p.cents)}</span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <ul className="grid gap-2.5">
                  {p.lines.map((l) => (
                    <li key={`${l.login}:${l.state}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <GithubAvatar login={l.login} size="size-7" />
                      <a href={`https://github.com/${l.login}`} className="font-medium hover:text-primary hover:underline">
                        @{l.login}
                      </a>
                      <Badge variant={STATE[l.state].variant} className="font-normal">
                        {STATE[l.state].label}
                      </Badge>
                      <span className="ml-auto tabular-nums">{formatUsd(l.cents)}</span>
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
    </Card>
  );
}
