import type { CheckResult } from "./types.js";

export interface CheckOptions {
  timeoutMs: number;
  retryDelayMs: number;
  expect?: Record<string, string> | undefined;
  apiKey?: string | undefined;
  database?: boolean | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function offline(responseTimeMs: number | null, error: string, statusCode: number | null = null): CheckResult {
  return { online: false, statusCode, responseTimeMs, error };
}

function requestHeaders(apiKey: string | undefined): Headers {
  const headers = new Headers({ accept: "application/json, text/html, text/plain;q=0.9, */*;q=0.8" });
  if (!apiKey) return headers;
  headers.set("apikey", apiKey);
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

async function databaseError(response: Response): Promise<string | null> {
  if (response.status >= 200 && response.status < 400) return null;
  let body = "";
  try {
    body = await response.text();
  } catch {
    return `HTTP ${response.status}`;
  }
  if (body.length > 16_384) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    if (parsed.code === "PGRST205") return null;
  } catch {
    return `HTTP ${response.status}`;
  }
  return `HTTP ${response.status}`;
}
function fieldError(key: string, want: string, got: unknown): string {
  if (typeof got !== "string" || got.length === 0 || got.length > 40) return `${key} is not ${want}`;
  return `${key} is ${got}`;
}

async function expectError(response: Response, expect: Record<string, string>): Promise<string | null> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    return "unreadable body";
  }
  if (body.length > 16_384) return "response body is too large";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "response is not JSON";
  }
  if (!parsed || typeof parsed !== "object") return "response is not JSON";
  const record = parsed as Record<string, unknown>;
  for (const [key, want] of Object.entries(expect)) {
    if (record[key] !== want) return fieldError(key, want, record[key]);
  }
  return null;
}

async function checkOnce(
  url: string,
  timeoutMs: number,
  expect: Record<string, string> | undefined,
  apiKey: string | undefined,
  database: boolean,
  fetchImpl: typeof fetch
): Promise<CheckResult> {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: requestHeaders(apiKey),
    });
    const responseTimeMs = Date.now() - started;
    if (database) {
      const problem = await databaseError(response);
      return {
        online: problem === null,
        statusCode: response.status,
        responseTimeMs,
        error: problem,
      };
    }
    if (response.status < 200 || response.status >= 400) {
      return offline(responseTimeMs, `HTTP ${response.status}`, response.status);
    }
    if (!expect) {
      return { online: true, statusCode: response.status, responseTimeMs, error: null };
    }
    const mismatch = await expectError(response, expect);
    return {
      online: mismatch === null,
      statusCode: response.status,
      responseTimeMs,
      error: mismatch,
    };
  } catch (error) {
    const responseTimeMs = Date.now() - started;
    if (error instanceof Error && error.name === "TimeoutError") return offline(responseTimeMs, "timeout");
    return offline(responseTimeMs, "unreachable");
  }
}

export async function checkUrl(url: string, options: CheckOptions): Promise<CheckResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const database = options.database === true;
  const first = await checkOnce(url, options.timeoutMs, options.expect, options.apiKey, database, fetchImpl);
  if (first.online || options.retryDelayMs === 0) return first;
  await sleep(options.retryDelayMs);
  return checkOnce(url, options.timeoutMs, options.expect, options.apiKey, database, fetchImpl);
}
