"use client";

import { useEffect, useState } from "react";
import { formatUsd } from "../../lib/format";
import type { MaintainerSummary } from "../../lib/maintainers/summary";

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

  if (me === null) return <p>Loading...</p>;
  if (me === "signed-out") {
    return (
      <>
        <p>
          When a developer&apos;s AI coding agent builds with your package, they can choose to pay you for it through Upstream. Sign in with
          GitHub to see what&apos;s waiting for you, then link PayPal to be paid.
        </p>
        <p>
          <a href="/maintainer/github/start">Sign in with GitHub</a>
        </p>
      </>
    );
  }

  return (
    <>
      <div>
        Signed in as <strong>{me.login}</strong>.{" "}
        <form method="post" action="/maintainer/signout" style={{ display: "inline" }}>
          <button type="submit">Sign out</button>
        </form>
      </div>
      {notice && <p role="status">{notice}</p>}

      <h2>Where we pay you</h2>
      {me.paypal.linked ? (
        <p>
          PayPal is linked.
          {me.paypal.firstPayoutFrom ? ` Your first payout can go out from ${me.paypal.firstPayoutFrom}.` : ""}{" "}
          <a href="/maintainer/paypal/start">Link a different PayPal account</a>
        </p>
      ) : (
        <p>
          <a href="/maintainer/paypal/start">Link PayPal</a> so we can pay you. Payouts start a week after you link it.
        </p>
      )}

      <h2>Your money</h2>
      <ul>
        <li>Waiting for you: {formatUsd(me.cents.waiting)}</li>
        <li>On its way: {formatUsd(me.cents.onItsWay)}</li>
        <li>Paid: {formatUsd(me.cents.paid)}</li>
      </ul>

      {me.months.length > 0 && (
        <>
          <h2>By month</h2>
          <ul>
            {me.months.map((m) => (
              <li key={m.month}>
                {m.month}: {formatUsd(m.setAsideCents)}
              </li>
            ))}
          </ul>
        </>
      )}

      {me.payouts.length > 0 && (
        <>
          <h2>Payouts</h2>
          <ul>
            {me.payouts.map((p, i) => (
              <li key={i}>
                {p.date}: {formatUsd(p.cents)}, {p.status === "SUCCESS" ? "paid" : p.status === "PENDING" ? "on its way" : p.status.toLowerCase()}
              </li>
            ))}
          </ul>
        </>
      )}

      {me.packages.length > 0 && (
        <>
          <h2>How agents use your packages</h2>
          <ul>
            {me.packages.map((p) => (
              <li key={`${p.ecosystem}:${p.name}`}>
                {p.name} ({formatUsd(p.cents)}):{" "}
                {Object.entries(p.roles)
                  .map(([role, n]) => `${ROLE[role] ?? role} ${times(n)}`)
                  .join(", ") || "no details yet"}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
