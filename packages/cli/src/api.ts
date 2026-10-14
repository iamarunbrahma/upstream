import type { DeviceResponse, ListResponse, ReceiptPayload, ReceiptStatus, ReceiptView, SubmitResponse } from "@upstream/core";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApi(apiUrl: string, token: string | null, fetchImpl: typeof fetch = fetch, timeoutMs = 60000) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(new URL(path, apiUrl), {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    return data as T;
  }
  return {
    registerDevice: (label: string | null) => call<DeviceResponse>("POST", "/api/devices", { label }),
    submit: (payload: ReceiptPayload) => call<SubmitResponse>("POST", "/api/receipts", payload),
    list: (status?: ReceiptStatus) => call<ListResponse>("GET", `/api/receipts${status ? `?status=${status}` : ""}`),
    get: (id: string) => call<{ receipt: ReceiptView }>("GET", `/api/receipts/${id}`),
    decide: (id: string, action: "approve" | "skip") => call<{ receipt: ReceiptView }>("POST", `/api/receipts/${id}/decision`, { action }),
    loginLink: () => call<{ url: string }>("POST", "/api/login-links"),
  };
}

export type Api = ReturnType<typeof createApi>;
