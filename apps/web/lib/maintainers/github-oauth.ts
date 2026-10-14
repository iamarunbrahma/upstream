/** GitHub's web sign-in (OAuth app). It asks for no scopes: only the public "who are you". */
export interface GithubOAuth {
  authorizeUrl(state: string, redirectUri: string): string;
  /** The GitHub account behind a sign-in code; null when GitHub refuses the code, or for an organisation. */
  identify(code: string, redirectUri: string): Promise<{ id: number; login: string } | null>;
}

export function createGithubOAuth(cfg: { clientId: string; clientSecret: string; fetchImpl?: typeof fetch }): GithubOAuth {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeout = () => AbortSignal.timeout(15_000);
  return {
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, state, scope: "", allow_signup: "false" });
      return `https://github.com/login/oauth/authorize?${q}`;
    },
    async identify(code, redirectUri) {
      const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri }),
        signal: timeout(),
      });
      const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: unknown };
      if (!tokenRes.ok || typeof token.access_token !== "string") return null;
      const userRes = await fetchImpl("https://api.github.com/user", {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}`, "user-agent": "upstream-pay" },
        signal: timeout(),
      });
      const user = (await userRes.json().catch(() => ({}))) as { id?: unknown; login?: unknown; type?: unknown };
      if (!userRes.ok || typeof user.id !== "number" || typeof user.login !== "string" || user.type !== "User") return null;
      return { id: user.id, login: user.login };
    },
  };
}
