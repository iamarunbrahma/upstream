import { CircleCheck, CircleX } from "lucide-react";
import type { Metadata } from "next";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Upstream payment" };

export default async function AgentPaid({ searchParams }: { searchParams: Promise<{ cancelled?: string }> }) {
  const cancelled = (await searchParams).cancelled === "1";
  return (
    <main className="mx-auto max-w-xl px-4 pt-16 pb-24">
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            {cancelled ? <CircleX className="size-5 text-muted-foreground" /> : <CircleCheck className="size-5 text-primary" />}
            {cancelled ? "You cancelled this payment" : "Payment approved"}
          </CardTitle>
          <CardDescription className="leading-relaxed">
            {cancelled
              ? "Nothing was charged. Ask your agent again whenever you want to add money."
              : "Go back to your coding agent and tell it you're done. It finishes the payment and tells you what was added to your budget."}
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}
