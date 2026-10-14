import { TIERS } from "../../lib/paypal/plans";
import { FundingPanel } from "./FundingPanel";

export const dynamic = "force-dynamic";

export default function Dashboard() {
  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1>Your Upstream budget</h1>
      <FundingPanel
        clientId={process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? ""}
        environment={process.env.NEXT_PUBLIC_PAYPAL_ENV === "production" ? "production" : "sandbox"}
        tiers={TIERS.map((t) => ({ key: t.key, label: t.label }))}
      />
    </main>
  );
}
