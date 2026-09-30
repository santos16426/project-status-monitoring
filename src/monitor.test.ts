import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildAlertContent, buildDashboardEmbed } from "./embed.js";
import { applyCheck } from "./evaluate.js";
import { parseState, saveState, stateFilePath } from "./store.js";
import { emptyFleetState, emptyProjectState, emptyServiceState, type ProjectTarget } from "./types.js";

const project: ProjectTarget = {
  id: "moolah",
  name: "Moolah",
  environment: "production",
  statusChannelId: "123456789012345678",
  checks: [
    { id: "frontend", name: "Frontend", url: "https://moolah.example", importance: "critical" },
    { id: "database", name: "Database", url: "https://api.example/ready", importance: "dependency" },
  ],
};

describe("dashboard", () => {
  it("builds one embed and omits secrets", () => {
    const state = emptyProjectState();
    state.checks.frontend = {
      ...emptyServiceState(),
      totalChecks: 1,
      successfulChecks: 1,
      status: "online",
      lastStatusCode: 200,
      lastResponseTimeMs: 120,
      lastCheckedAt: "2026-10-01T06:00:00.000Z",
    };
    const embed = buildDashboardEmbed(project, state, "Asia/Manila", 60, new Date("2026-10-01T06:00:00.000Z"));
    const text = JSON.stringify(embed);
    assert.equal(text.includes("DISCORD_BOT_TOKEN"), false);
    assert.match(embed.footer.text, /status-monitor:moolah/);
    assert.equal(embed.title, "Moolah");
    assert.equal(embed.url, "https://moolah.example");
    const frontend = embed.fields.find((field) => field.name === "FRONTEND");
    assert.ok(frontend);
    assert.match(frontend.value, /`🟢 Online · 120ms`/);
    assert.match(frontend.value, /```\nhttps:\/\/moolah\.example\n```/);
  });

  it("persists the message id under the project", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "status-monitor-"));
    const file = stateFilePath(directory);
    const state = emptyFleetState();
    state.projects.moolah = { messageId: "123456789012345678", checks: {} };
    await saveState(file, state);
    const loaded = parseState(await readFile(file, "utf8"));
    assert.equal(loaded.projects.moolah?.messageId, "123456789012345678");
  });

  it("names the project in the down alert", () => {
    let service = emptyServiceState();
    const now = new Date("2026-10-01T06:00:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      service = applyCheck(
        service,
        { online: false, statusCode: 502, responseTimeMs: 10, error: "HTTP 502" },
        now,
        0,
        "database"
      ).state;
    }
    const alert = buildAlertContent(
      "Moolah",
      "Database",
      { type: "down", startedAt: now.toISOString() },
      service,
      "Asia/Manila"
    );
    assert.match(alert, /Moolah/);
    assert.match(alert, /Database is down/);
    assert.match(alert, /HTTP 502/);
  });
});
