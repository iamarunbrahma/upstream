import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { MaintainerPanel } from "./MaintainerPanel";

export const metadata: Metadata = { title: "Upstream for maintainers" };

export default function MaintainerPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 pt-10 sm:pt-14">
      <Badge variant="outline" className="mb-4 gap-1.5 rounded-full px-3 py-1">
        <span className="size-1.5 rounded-full bg-primary" /> For maintainers
      </Badge>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Get paid for the open source AI agents use</h1>
      <p className="mt-2 mb-8 max-w-2xl text-muted-foreground">
        Money from developers&apos; budgets is filed under your GitHub account, so it waits for you even before you join.
      </p>
      <MaintainerPanel />
    </main>
  );
}
