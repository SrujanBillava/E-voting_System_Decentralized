/**
 * The one fetch wrapper. Every backend error is { error: { code, message, requestId, details? } } and becomes an ApiError;
 * a network failure becomes ApiError code "NETWORK" (status 0). No alert(), no raw error text shown to users.
 */
const API_BASE: string = import.meta.env.VITE_API_BASE ?? "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, requestId?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  token?: string | null;
  signal?: AbortSignal;
  /** Milliseconds before the request is abandoned. */
  timeoutMs?: number;
}
export interface RawResponse<T> {
  status: number;
  data: T;
}

export async function requestRaw<T>(method: string, path: string, options: RequestOptions = {}): Promise<RawResponse<T>> {
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { method, headers, body, credentials: "include", signal: controller.signal });
  } catch {
    throw new ApiError(0, "NETWORK", "The server could not be reached.");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) return { status: 204, data: undefined as T };
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // not JSON: handled below
  }
  const envelope = json as { data?: T; error?: { code?: string; message?: string; requestId?: string; details?: Record<string, unknown> } } | null;
  if (!response.ok) {
    const e = envelope?.error;
    throw new ApiError(response.status, e?.code ?? "UNKNOWN", e?.message ?? "Something went wrong.", e?.requestId, e?.details);
  }
  if (!envelope || !("data" in envelope)) throw new ApiError(response.status, "BAD_RESPONSE", "The server sent an unexpected response.");
  return { status: response.status, data: envelope.data as T };
}

export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  return (await requestRaw<T>(method, path, options)).data;
}
