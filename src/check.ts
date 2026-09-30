import type { CheckResult } from "./types.js";

export interface CheckOptions {
  timeoutMs: number;
  retryDelayMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function offline(responseTimeMs: number | null, error: string, statusCode: number | null = null): CheckResult {
  return { online: false, statusCode, responseTimeMs, error };
}

async function checkOnce(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<CheckResult> {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json, text/html;q=0.9, */*;q=0.8" },
    });
    const responseTimeMs = Date.now() - started;
    const online = response.status >= 200 && response.status < 400;
    return {
      online,
      statusCode: response.status,
      responseTimeMs,
      error: online ? null : `HTTP ${response.status}`,
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
  const first = await checkOnce(url, options.timeoutMs, fetchImpl);
  if (first.online || options.retryDelayMs === 0) return first;
  await sleep(options.retryDelayMs);
  return checkOnce(url, options.timeoutMs, fetchImpl);
}
