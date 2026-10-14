import { randomUUID } from "node:crypto";

export const SANDBOX_API = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    public readonly status: number,
    /** PayPal's issue code, e.g. ORDER_ALREADY_CAPTURED, or its error name. */
    public readonly code: string,
    message: string,
    public readonly debugId: string | null,
  ) {
    super(message);
  }
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface PayPalHttp {
  request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, opts?: { requestId?: string }): Promise<T>;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text.slice(0, 200) };
  }
}

/** PayPal REST client: caches the OAuth token until a minute before expiry and sends a request id on every write. */
export function createPayPalHttp(cfg: PayPalConfig): PayPalHttp {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const now = cfg.now ?? Date.now;
  const timeout = () => AbortSignal.timeout(cfg.timeoutMs ?? 20000);
  let token: { value: string; expiresAt: number } | null = null;

  /** fetch, with a timeout or a dropped connection raised as a PayPalError like any other PayPal failure. */
  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, init);
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new PayPalError(504, "TIMEOUT", "PayPal took too long to answer", null);
      }
      throw new PayPalError(502, "NETWORK_ERROR", "Couldn't reach PayPal", null);
    }
  }

  async function accessToken(): Promise<string> {
    if (token && now() < token.expiresAt) return token.value;
    const res = await send(`${cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: timeout(),
    });
    const data = await readJson(res);
    if (!res.ok || typeof data.access_token !== "string") {
      throw new PayPalError(res.status, "AUTHENTICATION_FAILURE", String(data.error_description ?? "PayPal login failed"), null);
    }
    const ttl = typeof data.expires_in === "number" ? data.expires_in : 0;
    token = { value: data.access_token, expiresAt: now() + Math.max(0, ttl - 60) * 1000 };
    return token.value;
  }

  return {
    async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, opts?: { requestId?: string }): Promise<T> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${await accessToken()}`,
        "content-type": "application/json",
        prefer: "return=representation",
      };
      if (method !== "GET") headers["paypal-request-id"] = opts?.requestId ?? randomUUID();
      const res = await send(`${cfg.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeout(),
      });
      if (res.status === 401) token = null; // expired or revoked: log in again next time
      const data = await readJson(res);
      if (!res.ok) {
        const details = Array.isArray(data.details) ? (data.details as Array<{ issue?: string }>) : [];
        throw new PayPalError(
          res.status,
          details[0]?.issue ?? String(data.name ?? "PAYPAL_ERROR"),
          String(data.message ?? `PayPal returned ${res.status}`),
          typeof data.debug_id === "string" ? data.debug_id : null,
        );
      }
      return data as T;
    },
  };
}
