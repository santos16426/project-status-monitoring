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

  it("requires the listed JSON fields and retries a mismatch", async () => {
    const seen: string[] = [];
    const result = await checkUrl("https://api.example/health", {
      timeoutMs: 1000,
      retryDelayMs: 5,
      expect: { status: "ok", db: "up" },
      sleep: async () => undefined,
      fetchImpl: async () => {
        seen.push("call");
        const body = seen.length === 1
          ? { status: "ok", db: "down" }
          : { status: "ok", db: "up", uptime: 12 };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    assert.equal(seen.length, 2);
    assert.equal(result.online, true);
    assert.equal(result.error, null);
  });

  it("stays offline when the database field is down", async () => {
    const result = await checkUrl("https://api.example/health", {
      timeoutMs: 1000,
      retryDelayMs: 0,
      expect: { db: "up" },
      fetchImpl: async () => new Response(JSON.stringify({ status: "ok", db: "down" }), { status: 200 }),
    });
    assert.equal(result.online, false);
    assert.equal(result.statusCode, 200);
    assert.equal(result.error, "db is down");
  });

  it("sends the anon key as headers and keeps it out of the result", async () => {
    const apiKey = "anon-key-0123456789abcdef";
    const result = await checkUrl("https://project.supabase.co/health", {
      timeoutMs: 1000,
      retryDelayMs: 0,
      apiKey,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("apikey"), apiKey);
        assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
        return new Response("Healthy", { status: 200 });
      },
    });
    assert.equal(result.online, true);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  });

  it("treats a missing PostgREST table as a live database", async () => {
    const result = await checkUrl("https://project.supabase.co/rest/v1/status_monitor_ping?select=id&limit=0", {
      timeoutMs: 1000,
      retryDelayMs: 0,
      database: true,
      apiKey: "anon-key-0123456789abcdef",
      fetchImpl: async () => new Response(JSON.stringify({
        code: "PGRST205",
        message: "Could not find the table 'public.status_monitor_ping' in the schema cache",
      }), { status: 404 }),
    });
    assert.equal(result.online, true);
    assert.equal(result.error, null);
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
