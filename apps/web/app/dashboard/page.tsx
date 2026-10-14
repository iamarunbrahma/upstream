import type { Metadata } from "next";
import { TIERS } from "@/lib/paypal/plans";
import { Dashboard } from "./Dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your Upstream dashboard" };

export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 pt-10 sm:pt-14">
      <Dashboard
        clientId={process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? ""}
        environment={process.env.NEXT_PUBLIC_PAYPAL_ENV === "production" ? "production" : "sandbox"}
        tiers={TIERS.map((t) => ({ key: t.key, label: t.label }))}
      />
    </main>
  );
}
