import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkUrl } from "./check.js";

describe("checkUrl", () => {
  it("treats HTTP 200 as online and skips the retry", async () => {
    let calls = 0;
    const result = await checkUrl("https://api.example/health", {
      timeoutMs: 1000,
      retryDelayMs: 2000,
      sleep: async () => {
        throw new Error("retry should not run");
      },
      fetchImpl: async () => {
        calls += 1;
        return new Response("ok", { status: 200 });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.online, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.error, null);
  });

  it("retries once after a failure", async () => {
    const seen: number[] = [];
    const result = await checkUrl("https://api.example/ready", {
      timeoutMs: 1000,
      retryDelayMs: 5,
      sleep: async () => undefined,
      fetchImpl: async () => {
        seen.push(1);
        if (seen.length === 1) return new Response("down", { status: 503 });
        return new Response("ok", { status: 200 });
      },
    });
    assert.equal(seen.length, 2);
    assert.equal(result.online, true);
    assert.equal(result.statusCode, 200);
  });

  it("reports unreachable without the response body", async () => {
    const result = await checkUrl("https://api.example/health", {
      timeoutMs: 1000,
      retryDelayMs: 0,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED secret-host");
      },
    });
    assert.equal(result.online, false);
    assert.equal(result.error, "unreachable");
    assert.equal(JSON.stringify(result).includes("secret-host"), false);
  });
});
