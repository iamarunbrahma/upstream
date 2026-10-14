import { describe, expect, it } from "vitest";
import { createGithubOAuth } from "../lib/maintainers/github-oauth";
import { createPayPalIdentity } from "../lib/maintainers/paypal-identity";
import { SANDBOX_API } from "../lib/paypal/client";

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);
const back = "https://up.test/maintainer/github/callback";

describe("GitHub sign-in", () => {
  it("sends people to GitHub asking for nothing but who they are", () => {
    const gh = createGithubOAuth({ clientId: "gh-id", clientSecret: "gh-secret" });
    const url = new URL(gh.authorizeUrl("st4te", back));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "gh-id", redirect_uri: back, state: "st4te", scope: "", allow_signup: "false" });
  });

  it("turns the code GitHub sends back into the person's GitHub id and login", async () => {
    const f = fakeFetch([
      { status: 200, body: { access_token: "gho_1", token_type: "bearer", scope: "" } },
      { status: 200, body: { id: 7, login: "Alice", type: "User" } },
    ]);
    const gh = createGithubOAuth({ clientId: "gh-id", clientSecret: "gh-secret", fetchImpl: f.impl });
    expect(await gh.identify("c0de", back)).toEqual({ id: 7, login: "Alice" });
    expect(f.calls[0]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(header(f.calls[0]!, "accept")).toBe("application/json");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ client_id: "gh-id", client_secret: "gh-secret", code: "c0de", redirect_uri: back });
    expect(f.calls[1]!.url).toBe("https://api.github.com/user");
    expect(header(f.calls[1]!, "authorization")).toBe("Bearer gho_1");
  });

  it("answers null for a code GitHub refuses, and for an organisation", async () => {
    const refused = fakeFetch([{ status: 200, body: { error: "bad_verification_code" } }]);
    expect(await createGithubOAuth({ clientId: "i", clientSecret: "s", fetchImpl: refused.impl }).identify("old", back)).toBeNull();
    const org = fakeFetch([
      { status: 200, body: { access_token: "gho_2" } },
      { status: 200, body: { id: 9, login: "acme", type: "Organization" } },
    ]);
    expect(await createGithubOAuth({ clientId: "i", clientSecret: "s", fetchImpl: org.impl }).identify("c", back)).toBeNull();
  });
});

describe("Log in with PayPal", () => {
  const ppBack = "https://up.test/maintainer/paypal/callback";

  it("sends people to the sandbox's sign-in page, asking for their PayPal account id", () => {
    const pp = createPayPalIdentity({ clientId: "pp-id", clientSecret: "pp-secret", apiBase: SANDBOX_API });
    const url = new URL(pp.authorizeUrl("st4te", ppBack));
    expect(url.origin + url.pathname).toBe("https://www.sandbox.paypal.com/signin/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      flowEntry: "static",
      client_id: "pp-id",
      response_type: "code",
      scope: "openid https://uri.paypal.com/services/paypalattributes",
      redirect_uri: ppBack,
      state: "st4te",
    });
    const live = createPayPalIdentity({ clientId: "pp-id", clientSecret: "s", apiBase: "https://api-m.paypal.com" });
    expect(new URL(live.authorizeUrl("x", ppBack)).origin).toBe("https://www.paypal.com");
  });

  it("turns the code PayPal sends back into the account id, and whether PayPal verified the account", async () => {
    const f = fakeFetch([
      { status: 200, body: { access_token: "A21-user", token_type: "Bearer" } },
      { status: 200, body: { user_id: "https://www.paypal.com/webapps/auth/identity/user/x", payer_id: "PAYER-1", verified_account: "true" } },
    ]);
    const pp = createPayPalIdentity({ clientId: "pp-id", clientSecret: "pp-secret", apiBase: "https://api.test", fetchImpl: f.impl });
    expect(await pp.identify("c0de", ppBack)).toEqual({ payerId: "PAYER-1", verified: true });
    expect(f.calls[0]!.url).toBe("https://api.test/v1/oauth2/token");
    expect(header(f.calls[0]!, "authorization")).toBe(`Basic ${Buffer.from("pp-id:pp-secret").toString("base64")}`);
    expect(new URLSearchParams(String(f.calls[0]!.init.body)).get("grant_type")).toBe("authorization_code");
    expect(new URLSearchParams(String(f.calls[0]!.init.body)).get("code")).toBe("c0de");
    expect(f.calls[1]!.url).toBe("https://api.test/v1/identity/oauth2/userinfo?schema=paypalv1.1");
    expect(header(f.calls[1]!, "authorization")).toBe("Bearer A21-user");
  });

  it("reports an attribute PayPal left out as missing, not as an unverified account", async () => {
    const noVerified = fakeFetch([
      { status: 200, body: { access_token: "t" } },
      { status: 200, body: { payer_id: "PAYER-3" } },
    ]);
    expect(await createPayPalIdentity({ clientId: "i", clientSecret: "s", apiBase: "https://api.test", fetchImpl: noVerified.impl }).identify("c", ppBack)).toEqual({
      payerId: "PAYER-3",
      verified: null,
    });
    const noPayer = fakeFetch([
      { status: 200, body: { access_token: "t" } },
      { status: 200, body: { verified_account: "true" } },
    ]);
    expect(await createPayPalIdentity({ clientId: "i", clientSecret: "s", apiBase: "https://api.test", fetchImpl: noPayer.impl }).identify("c", ppBack)).toEqual({
      payerId: null,
      verified: true,
    });
  });

  it("reports an unverified account as such, and answers null for a code PayPal refuses", async () => {
    const unverified = fakeFetch([
      { status: 200, body: { access_token: "t" } },
      { status: 200, body: { payer_id: "PAYER-2", verified_account: false } },
    ]);
    expect(await createPayPalIdentity({ clientId: "i", clientSecret: "s", apiBase: "https://api.test", fetchImpl: unverified.impl }).identify("c", ppBack)).toEqual({
      payerId: "PAYER-2",
      verified: false,
    });
    const refused = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
    expect(await createPayPalIdentity({ clientId: "i", clientSecret: "s", apiBase: "https://api.test", fetchImpl: refused.impl }).identify("old", ppBack)).toBeNull();
  });
});
