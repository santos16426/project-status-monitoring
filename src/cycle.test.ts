import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";
import { runCycle } from "./cycle.js";
import type { DiscordPublisher } from "./discord.js";
import { emptyFleetState, type CheckResult } from "./types.js";

const projects = [
  {
    id: "moolah",
    name: "Moolah",
    environment: "production",
    checks: [
      { id: "frontend", name: "Frontend", url: "https://moolah.example", importance: "critical" },
      { id: "backend", name: "Backend", url: "https://api.example/health", importance: "critical" },
      { id: "database", name: "Database", url: "https://api.example/ready", importance: "dependency" },
    ],
  },
  {
    id: "planera",
    name: "Planera",
    checks: [{ id: "frontend", name: "Frontend", url: "https://planera.example", importance: "critical" }],
  },
];

const config = await loadConfig({
  DISCORD_BOT_TOKEN: "test-token-with-enough-length",
  DISCORD_STATUS_CHANNEL_ID: "123456789012345678",
  DISCORD_ALERT_CHANNEL_ID: "223456789012345678",
  PROJECTS_JSON: JSON.stringify(projects),
});

function publisher(): DiscordPublisher & { alerts: string[]; dashboards: number; alertEdits: number; alertCreates: number } {
  let nextAlertId = 900000;
  const record = {
    alerts: [] as string[],
    dashboards: 0,
    alertEdits: 0,
    alertCreates: 0,
    async publishDashboard(): Promise<string> {
      record.dashboards += 1;
      return "323456789012345678";
    },
    async publishAlert(_channelId: string, messageId: string | null, content: string): Promise<string> {
      record.alerts.push(content);
      if (messageId) {
        record.alertEdits += 1;
        return messageId;
      }
      record.alertCreates += 1;
      nextAlertId += 1;
      return String(nextAlertId);
    },
  };
  return record;
}

const online: CheckResult = { online: true, statusCode: 200, responseTimeMs: 20, error: null };
const databaseDown: CheckResult = { online: false, statusCode: 503, responseTimeMs: 20, error: "HTTP 503" };

describe("runCycle", () => {
  it("publishes one dashboard per project while checks pass", async () => {
    const discord = publisher();
    const next = await runCycle(config, emptyFleetState(), discord, new Date(), async () => online);
    assert.equal(discord.dashboards, 2);
    assert.deepEqual(discord.alerts, []);
    assert.equal(next.projects.moolah?.checks.backend?.status, "online");
    assert.equal(next.projects.planera?.checks.frontend?.status, "online");
    assert.equal(Object.keys(next.projects).length, 2);
  });

  it("alerts only moolah on the third consecutive database failure", async () => {
    const discord = publisher();
    let state = emptyFleetState();
    for (let index = 0; index < 3; index += 1) {
      state = await runCycle(
        config,
        state,
        discord,
        new Date(`2026-10-01T06:0${index}:00.000Z`),
        async (url) => (url.endsWith("/ready") ? databaseDown : online)
      );
    }
    assert.equal(discord.alerts.length, 1);
    assert.match(discord.alerts[0] ?? "", /Moolah/);
    assert.match(discord.alerts[0] ?? "", /Database is down/);
    assert.equal(state.projects.moolah?.checks.database?.pendingAlert, null);
    assert.equal(state.projects.planera?.checks.frontend?.status, "online");
    assert.equal(discord.alerts.some((alert) => alert.includes("Planera")), false);
  });

  it("edits the same alert message through down → reminder → recovery instead of spamming new ones", async () => {
    const discord = publisher();
    let state = emptyFleetState();

    // 3 consecutive failures to trigger the initial "down" alert
    for (let index = 0; index < 3; index += 1) {
      state = await runCycle(
        config,
        state,
        discord,
        new Date(`2026-10-01T06:0${index}:00.000Z`),
        async (url) => (url.endsWith("/ready") ? databaseDown : online)
      );
    }
    assert.equal(discord.alertCreates, 1);
    assert.equal(discord.alertEdits, 0);
    const openMessageId = state.projects.moolah?.checks.database?.alertMessageId;
    assert.ok(openMessageId, "expected an open alert message id after the first down alert");

    // The down alert fired on the 3rd check (06:02), so lastReminderAt starts there.
    // 30+ minutes after THAT, still down — should trigger a "reminder" that EDITS, not creates.
    state = await runCycle(
      config,
      state,
      discord,
      new Date("2026-10-01T06:33:00.000Z"),
      async (url) => (url.endsWith("/ready") ? databaseDown : online)
    );
    assert.equal(discord.alertCreates, 1, "reminder should not create a new message");
    assert.equal(discord.alertEdits, 1, "reminder should edit the existing message");
    assert.equal(state.projects.moolah?.checks.database?.alertMessageId, openMessageId);

    // Recovers — should edit that same message one last time, then clear the id
    state = await runCycle(config, state, discord, new Date("2026-10-01T06:34:00.000Z"), async () => online);
    state = await runCycle(config, state, discord, new Date("2026-10-01T06:35:00.000Z"), async () => online);
    assert.equal(discord.alertCreates, 1, "recovery should not create a new message either");
    assert.equal(discord.alertEdits, 2, "recovery should edit the existing message");
    assert.equal(state.projects.moolah?.checks.database?.alertMessageId, null, "incident should be cleared so the next outage starts fresh");
  });
});