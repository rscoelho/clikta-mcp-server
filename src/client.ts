import { API_TOKEN, API_URL } from "./config.js";

export class ClicktaApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ClicktaApiError";
  }
}

// Transient failures worth retrying: request-timeout/conflict/rate-limit/server
// errors. Everything else (400/401/404/...) is a real client error that will
// fail the same way again — retrying just delays the useful error message.
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attempt<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_TOKEN}`,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ClicktaApiError(
      res.status,
      `Clikta API ${init.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 300)}`
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_TOKEN) {
    throw new Error(
      "CLIKTA_API_TOKEN is not set. Generate one in the Clikta web app under Settings -> API Token, " +
        "then set it in this MCP server's environment (see .env.example)."
    );
  }

  let lastErr: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await attempt<T>(path, init);
    } catch (err) {
      lastErr = err;
      // Genuine network failures (connection refused, DNS, socket reset) surface
      // as a TypeError from fetch() — worth retrying the same as a 5xx.
      const retryable = err instanceof ClicktaApiError ? RETRYABLE_STATUS.has(err.status) : err instanceof TypeError;
      if (!retryable || i === MAX_ATTEMPTS - 1) throw err;
      await sleep(BASE_DELAY_MS * 2 ** i);
    }
  }
  throw lastErr;
}

export interface Recording {
  id: string;
  name: string;
  status: string;
  shareId: string | null;
  published: boolean;
}

export interface ToolSummary {
  id: string;
  name: string;
  url: string | null;
}

export interface EventPayload {
  type: "navigate" | "click" | "input" | "submit";
  url: string;
  pageTitle?: string | null;
  elementTag?: string | null;
  elementLabel?: string | null;
  elementSelector?: string | null;
  inputValue?: string | null;
  clickX?: number | null;
  clickY?: number | null;
  viewportWidth?: number | null;
  viewportHeight?: number | null;
  screenshot?: string; // base64, no data: prefix — matches what the extension sends
}

export const clicktaApi = {
  createRecording: (data: { name: string; objective?: string; toolId?: string }) =>
    request<Recording>("/api/recordings", {
      method: "POST",
      body: JSON.stringify({ ...data, source: "mcp" }),
    }),

  patchRecording: (id: string, data: Record<string, unknown>) =>
    request<Recording>(`/api/recordings/${id}`, { method: "PATCH", body: JSON.stringify(data) }),

  postEvent: (id: string, event: EventPayload) =>
    request<{ id: string; order: number }>(`/api/recordings/${id}/events`, {
      method: "POST",
      body: JSON.stringify(event),
    }),

  postTranscript: (id: string, text: string, timestamp = Date.now()) =>
    request<{ ok: boolean; id: string }>(`/api/recordings/${id}/transcript`, {
      method: "POST",
      body: JSON.stringify({ text, timestamp }),
    }),

  postScreenshot: (data: {
    image: string;
    title?: string;
    url?: string;
    pageTitle?: string;
    viewportWidth?: number;
    viewportHeight?: number;
    toolId?: string;
  }) => request<{ id: string; shareId?: string }>("/api/screenshots", { method: "POST", body: JSON.stringify(data) }),

  generateRecording: (id: string) =>
    request<{ ok: boolean; title?: string; stepsCount?: number; aiGenerated?: boolean }>(
      `/api/recordings/${id}/generate`,
      { method: "POST" }
    ),

  publishRecording: (id: string) =>
    request<{ shareId: string; published: boolean; url: string }>(`/api/recordings/${id}/publish`, {
      method: "POST",
    }),

  listRecordings: () => request<Recording[]>("/api/recordings"),

  listTools: () => request<ToolSummary[]>("/api/tools"),
};
