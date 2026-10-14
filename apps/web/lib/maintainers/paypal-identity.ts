import { SANDBOX_API } from "../paypal/client";

/** Log in with PayPal, used only to learn which PayPal account a maintainer owns. */
export interface PayPalIdentity {
  authorizeUrl(state: string, redirectUri: string): string;
  /**
   * The PayPal account behind a sign-in code, and whether PayPal verified it; null when PayPal refuses the code.
   * An attribute PayPal leaves out is null: that means the app's Log in with PayPal settings don't ask for it.
   */
  identify(code: string, redirectUri: string): Promise<{ payerId: string | null; verified: boolean | null } | null>;
}

/** openid plus "PayPal account attributes", which carries payer_id and verified_account. */
const SCOPE = "openid https://uri.paypal.com/services/paypalattributes";

export function createPayPalIdentity(cfg: { clientId: string; clientSecret: string; apiBase: string; fetchImpl?: typeof fetch }): PayPalIdentity {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeout = () => AbortSignal.timeout(15_000);
  const signIn = cfg.apiBase === SANDBOX_API ? "https://www.sandbox.paypal.com" : "https://www.paypal.com";
  return {
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({ flowEntry: "static", client_id: cfg.clientId, response_type: "code", scope: SCOPE, redirect_uri: redirectUri, state });
      return `${signIn}/signin/authorize?${q}`;
    },
    async identify(code, redirectUri) {
      const tokenRes = await fetchImpl(`${cfg.apiBase}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
        signal: timeout(),
      });
      const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: unknown };
      if (!tokenRes.ok || typeof token.access_token !== "string") return null;
      const infoRes = await fetchImpl(`${cfg.apiBase}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, {
        headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
        signal: timeout(),
      });
      const info = (await infoRes.json().catch(() => ({}))) as { payer_id?: unknown; verified_account?: unknown };
      if (!infoRes.ok) return null;
      const payerId = typeof info.payer_id === "string" && info.payer_id ? info.payer_id : null;
      const verified = info.verified_account === undefined || info.verified_account === null ? null : info.verified_account === true || info.verified_account === "true";
      return { payerId, verified };
    },
  };
}
