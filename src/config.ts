import { readFile } from "node:fs/promises";
import { dashboardMarker, type CheckTarget, type Importance, type ProjectTarget } from "./types.js";

export interface MonitorConfig {
  discordToken: string;
  alertChannelId: string | null;
  checkIntervalSeconds: number;
  requestTimeoutMs: number;
  retryDelayMs: number;
  reminderMs: number;
  timeZone: string;
  port: number;
  dataDir: string;
  projects: ProjectTarget[];
}

const SNOWFLAKE = /^\d{17,20}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function channelId(value: unknown, label: string, fallback: string | null): string {
  if (typeof value !== "string" || value.trim() === "") {
    if (fallback) return fallback;
    throw new Error(`${label}.discord_status_channel_id is required`);
  }
  const id = value.trim();
  if (!SNOWFLAKE.test(id)) throw new Error(`${label}.discord_status_channel_id must be a Discord channel id`);
  return id;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function publicUrl(value: string, name: string, production: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (
    production &&
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(parsed.hostname)
  ) {
    throw new Error(`${name} must use https in production`);
  }
  if (parsed.searchParams.has("apikey") || parsed.searchParams.has("api_key")) {
    throw new Error(`${name} must not contain an api key`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function parseCheck(value: unknown, label: string, production: boolean): CheckTarget {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const id = value.id;
  const name = value.name;
  const url = value.url;
  if (typeof id !== "string" || !SLUG.test(id)) {
    throw new Error(`${label}.id must be a lowercase slug`);
  }
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 80) {
    throw new Error(`${label}.name must be 1-80 characters`);
  }
  if (typeof url !== "string") throw new Error(`${label}.url is required`);
  const importance: Importance = value.importance === "dependency" ? "dependency" : "critical";
  if (value.importance !== undefined && value.importance !== "critical" && value.importance !== "dependency") {
    throw new Error(`${label}.importance must be critical or dependency`);
  }
  return {
    id,
    name: name.trim(),
    url: publicUrl(url, `${label}.url`, production),
    importance,
    expect: parseExpect(value.expect, label),
    apiKey: parseApiKey(value.apiKey, label),
    database: parseDatabase(value.database, label),
  };
}

function parseApiKey(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 20 || value.length > 500 || /\s/.test(value)) {
    throw new Error(`${label}.apiKey must be a single token`);
  }
  return value;
}

function parseDatabase(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== true) throw new Error(`${label}.database must be true when set`);
  return true;
}

function parseExpect(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label}.expect must be an object`);
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 8) {
    throw new Error(`${label}.expect must have 1 to 8 fields`);
  }
  const expect: Record<string, string> = {};
  for (const [key, field] of entries) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) {
      throw new Error(`${label}.expect keys must be lowercase`);
    }
    if (typeof field !== "string" || field.length === 0 || field.length > 40) {
      throw new Error(`${label}.expect.${key} must be a short string`);
    }
    expect[key] = field;
  }
  return expect;
}

export function parseProjects(raw: string, production: boolean, fallbackChannelId: string | null = null): ProjectTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Project list must be JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 25) {
    throw new Error("Project list must contain 1 to 25 projects");
  }
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const label = `projects[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object`);
    const id = entry.id;
    const name = entry.name;
    if (typeof id !== "string" || !SLUG.test(id)) throw new Error(`${label}.id must be a lowercase slug`);
    if (seen.has(id)) throw new Error(`Duplicate project id ${id}`);
    seen.add(id);
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 80) {
      throw new Error(`${label}.name must be 1-80 characters`);
    }
    if (!Array.isArray(entry.checks) || entry.checks.length === 0 || entry.checks.length > 20) {
      throw new Error(`${label}.checks must contain 1 to 20 checks`);
    }
    const checkIds = new Set<string>();
    const checks = entry.checks.map((check, checkIndex) => {
      const parsedCheck = parseCheck(check, `${label}.checks[${checkIndex}]`, production);
      if (checkIds.has(parsedCheck.id)) throw new Error(`Duplicate check id ${parsedCheck.id} in ${id}`);
      checkIds.add(parsedCheck.id);
      return parsedCheck;
    });
    const environment = typeof entry.environment === "string" && entry.environment.trim()
      ? entry.environment.trim()
      : "production";
    const statusChannelId = channelId(
      entry.discord_status_channel_id ?? entry.discordStatusChannelId,
      label,
      fallbackChannelId
    );
    return { id, name: name.trim(), environment, statusChannelId, checks };
  });
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<MonitorConfig> {
  const production = env.NODE_ENV === "production";
  const fallbackChannel = env.DISCORD_STATUS_CHANNEL_ID?.trim() ?? "";
  if (fallbackChannel && !SNOWFLAKE.test(fallbackChannel)) {
    throw new Error("DISCORD_STATUS_CHANNEL_ID must be a Discord channel id");
  }
  const alertChannel = env.DISCORD_ALERT_CHANNEL_ID?.trim();
  if (alertChannel && !SNOWFLAKE.test(alertChannel)) {
    throw new Error("DISCORD_ALERT_CHANNEL_ID must be a Discord channel id");
  }
  const token = required(env, "DISCORD_BOT_TOKEN");
  if (token.length < 20) throw new Error("DISCORD_BOT_TOKEN is too short");

  const inline = env.PROJECTS_JSON?.trim();
  const file = env.PROJECTS_FILE?.trim() || "./projects.json";
  const raw = inline && inline.length > 0 ? inline : await readFile(file, "utf8");
  const projects = parseProjects(raw, production, fallbackChannel.length > 0 ? fallbackChannel : null);

  return {
    discordToken: token,
    alertChannelId: alertChannel && alertChannel.length > 0 ? alertChannel : null,
    checkIntervalSeconds: positiveInteger(env.CHECK_INTERVAL_SECONDS, 60, "CHECK_INTERVAL_SECONDS", 10, 3600),
    requestTimeoutMs: positiveInteger(env.REQUEST_TIMEOUT_MS, 10_000, "REQUEST_TIMEOUT_MS", 1000, 30_000),
    retryDelayMs: positiveInteger(env.RETRY_DELAY_MS, 2000, "RETRY_DELAY_MS", 0, 10_000),
    reminderMs: positiveInteger(env.REMINDER_MINUTES, 30, "REMINDER_MINUTES", 0, 24 * 60) * 60 * 1000,
    timeZone: env.TIME_ZONE?.trim() || "Asia/Manila",
    port: positiveInteger(env.PORT, 8080, "PORT", 1, 65535),
    dataDir: env.DATA_DIR?.trim() || "./data",
    projects,
  };
}

export { dashboardMarker };
