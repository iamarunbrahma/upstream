"use client";

import { Bot, Check, Loader2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { call, type ReceiptView } from "./api";

const ROLE: Record<string, string> = {
  foundation: "Built on it",
  feature: "One feature",
  helper: "A helper",
  tooling: "A tool",
};

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  proposed: { label: "Waiting for you", variant: "default" },
  approved: { label: "Approved", variant: "secondary" },
  skipped: { label: "Skipped", variant: "outline" },
  expired: { label: "Dropped after 14 days", variant: "outline" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the agent did with a package, from the evidence counted on the developer's machine. */
function evidenceText(e: ReceiptView["items"][number]["evidence"]): string {
  const parts: string[] = [];
  if (e.installed) parts.push("installed");
  if (e.manifestAdded) parts.push("added to the project");
  if (e.importFiles) parts.push(`imported in ${plural(e.importFiles, "file")}`);
  if (e.usageLines) parts.push(`${plural(e.usageLines, "line")} of new code ${e.usageLines === 1 ? "uses" : "use"} it`);
  if (e.docsReads) parts.push(`docs read ${plural(e.docsReads, "time")}`);
  if (e.kind === "devDependency") parts.push("a dev tool");
  const text = parts.join(", ") || "used this session";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ReceiptCard(props: { receipt: ReceiptView; onChange: () => Promise<void> }) {
  const r = props.receipt;
  const [busy, setBusy] = useState<"approve" | "skip" | null>(null);
  const status = STATUS[r.status] ?? { label: r.status, variant: "outline" as const };

  async function decide(action: "approve" | "skip") {
    setBusy(action);
    try {
      await call("POST", `/api/receipts/${r.id}/decision`, { action });
      await props.onChange();
      toast.success(action === "approve" ? "Approved. The next settlement spends your budget on these packages." : "Skipped. Nothing from this session will be paid.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base font-semibold">{r.title ?? "A Claude Code session"}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{new Date(r.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <Bot className="size-3.5" />
            {r.source === "ai" ? `Weighed by ${r.modelId ?? "the AI judge"}` : "Estimated without AI (the judge was unavailable)"}
          </span>
          <span aria-hidden>·</span>
          <span className="font-mono text-xs">{r.promptVersion}</span>
        </CardDescription>
        <CardAction>
          <Badge variant={status.variant}>{status.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Package</TableHead>
              <TableHead className="w-40">Share</TableHead>
              <TableHead className="hidden md:table-cell">Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.items.map((i) => (
              <TableRow key={`${i.ecosystem}:${i.name}`} className="align-top">
                <TableCell className="py-3">
                  <div className="font-medium">{i.name}</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Badge variant="outline" className="font-normal">
                      {ROLE[i.role] ?? i.role}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{i.ecosystem}</span>
                  </div>
                  <p className="mt-2 max-w-xs text-xs whitespace-normal text-muted-foreground md:hidden">{i.reason}</p>
                </TableCell>
                <TableCell className="py-3">
                  <div className="flex items-center gap-2">
                    <span className="w-12 text-right font-semibold tabular-nums">{i.percent}</span>
                    <Progress value={i.weightBp / 100} className="h-1.5" />
                  </div>
                </TableCell>
                <TableCell className="hidden py-3 whitespace-normal md:table-cell">
                  <div>{i.reason}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{evidenceText(i.evidence)}.</div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {r.status === "proposed" && (
        <CardFooter className="flex-wrap gap-3 border-t">
          <Button disabled={busy !== null} onClick={() => void decide("approve")}>
            {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Approve
          </Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => void decide("skip")}>
            {busy === "skip" ? <Loader2 className="animate-spin" /> : <X />} Skip
          </Button>
          <span className="text-xs text-muted-foreground">Approving lets the next settlement spend your budget on these packages.</span>
        </CardFooter>
      )}
    </Card>
  );
}

export function Receipts(props: { receipts: ReceiptView[]; onChange: () => Promise<void> }) {
  if (props.receipts.length === 0) {
    return (
      <Card className="border-dashed shadow-none">
        <CardHeader className="text-center">
          <CardTitle className="text-base">No receipts yet</CardTitle>
          <CardDescription>
            They arrive when a Claude Code session with the Upstream plugin ends, or from <code className="font-mono">upstream scan</code>.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <div className="grid gap-4">
      {props.receipts.map((r) => (
        <ReceiptCard key={r.id} receipt={r} onChange={props.onChange} />
      ))}
    </div>
  );
}
