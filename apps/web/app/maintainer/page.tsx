import type { Metadata } from "next";
import { MaintainerPanel } from "./MaintainerPanel";

export const metadata: Metadata = { title: "Upstream for maintainers" };

export default function MaintainerPage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "48px auto", padding: "0 16px", lineHeight: 1.5 }}>
      <h1>Get paid for the open source AI agents use</h1>
      <MaintainerPanel />
    </main>
  );
}
