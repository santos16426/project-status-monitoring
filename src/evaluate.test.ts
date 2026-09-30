import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCheck, FAILURES_BEFORE_DOWN } from "./evaluate.js";
import { emptyServiceState } from "./types.js";

const now = new Date("2026-10-01T06:00:00.000Z");

function fail(times: number) {
  let state = emptyServiceState();
  for (let index = 0; index < times; index += 1) {
    state = applyCheck(
      state,
      { online: false, statusCode: 503, responseTimeMs: 20, error: "HTTP 503" },
      now,
      30 * 60 * 1000,
      "backend"
    ).state;
  }
  return state;
}

describe("applyCheck", () => {
  it("waits for three consecutive failures before a down alert", () => {
    const once = applyCheck(
      emptyServiceState(),
      { online: false, statusCode: null, responseTimeMs: 10, error: "timeout" },
      now,
      0,
      "backend"
    );
    assert.equal(once.event, null);
    assert.equal(once.state.status, "unknown");

    const warn = fail(2);
    assert.equal(warn.downAlertSent, false);
    assert.equal(warn.status, "unknown");

    const down = applyCheck(
      warn,
      { online: false, statusCode: 502, responseTimeMs: 12, error: "HTTP 502" },
      now,
      30 * 60 * 1000,
      "backend"
    );
    assert.equal(down.event?.type, "down");
    assert.equal(down.state.status, "offline");
    assert.equal(down.state.pendingAlert, "down");
    assert.equal(down.state.consecutiveFailures, FAILURES_BEFORE_DOWN);
  });

  it("sends recovery only after two successful checks", () => {
    const down = fail(3);
    const first = applyCheck(
      down,
      { online: true, statusCode: 200, responseTimeMs: 40, error: null },
      now,
      0,
      "backend"
    );
    assert.equal(first.event, null);
    assert.equal(first.state.status, "offline");

    const second = applyCheck(
      first.state,
      { online: true, statusCode: 200, responseTimeMs: 41, error: null },
      new Date("2026-10-01T06:04:00.000Z"),
      0,
      "backend"
    );
    assert.equal(second.event?.type, "recovery");
    assert.equal(second.state.status, "online");
    assert.equal(second.state.pendingAlert, "recovery");
    if (second.event?.type === "recovery") {
      assert.equal(second.event.resolvedAt, "2026-10-01T06:04:00.000Z");
    }
  });

  it("does not repeat the down alert while the outage continues", () => {
    const down = fail(3);
    const again = applyCheck(
      down,
      { online: false, statusCode: 503, responseTimeMs: 15, error: "HTTP 503" },
      new Date("2026-10-01T06:01:00.000Z"),
      30 * 60 * 1000,
      "backend"
    );
    assert.equal(again.event, null);
    assert.equal(again.state.downAlertSent, true);
  });
});
