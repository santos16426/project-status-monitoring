import {
  dashboardMarker,
  type CheckTarget,
  type ProjectState,
  type ProjectTarget,
  type ServiceState,
} from "./types.js";

export interface DiscordEmbed {
  title: string;
  url: string;
  description: string;
  color: number;
  fields: { name: string; value: string; inline: boolean }[];
  footer: { text: string };
  timestamp: string;
}

const COLOR = {
  operational: 0x57f287,
  degraded: 0xfee75c,
  outage: 0xed4245,
  unknown: 0x99aab5,
} as const;

export type OverallStatus = "operational" | "degraded" | "partial" | "major" | "unknown";

function warning(state: ServiceState): boolean {
  return state.status !== "offline" && state.consecutiveFailures >= 2;
}

export function overallStatus(project: ProjectTarget, state: ProjectState): OverallStatus {
  const rows = project.checks.map((check) => state.checks[check.id]).filter((row): row is ServiceState => Boolean(row));
  if (rows.every((row) => row.totalChecks === 0)) return "unknown";
  if (rows.every((row) => row.status === "offline")) return "major";
  const criticalDown = project.checks.some((check) => check.importance === "critical" && state.checks[check.id]?.status === "offline");
  if (criticalDown) return "partial";
  const degraded = project.checks.some((check) => {
    const row = state.checks[check.id];
    if (!row) return false;
    return row.status === "offline" || row.status === "unknown" || warning(row);
  });
  if (degraded) return "degraded";
  return "operational";
}

function overallChip(status: OverallStatus): string {
  if (status === "operational") return "`🟢 Online`";
  if (status === "degraded") return "`🟡 Degraded`";
  if (status === "partial") return "`🔴 Partial outage`";
  if (status === "major") return "`🔴 Offline`";
  return "`⚪ Checking`";
}

function overallColor(status: OverallStatus): number {
  if (status === "operational") return COLOR.operational;
  if (status === "degraded") return COLOR.degraded;
  if (status === "partial" || status === "major") return COLOR.outage;
  return COLOR.unknown;
}

function statusChip(state: ServiceState | undefined): string {
  if (!state || state.totalChecks === 0) return "`⚪ Checking`";
  if (state.status === "offline" && state.consecutiveSuccesses === 1) return "`🟡 Recovering`";
  if (state.status === "offline") return "`🔴 Offline`";
  if (warning(state)) return "`🟡 Unstable`";
  if (state.status === "online") {
    const timing = state.lastResponseTimeMs === null ? "" : ` · ${state.lastResponseTimeMs}ms`;
    return `\`🟢 Online${timing}\``;
  }
  if (state.consecutiveFailures > 0) return "`⚪ Checking`";
  return "`⚪ Unknown`";
}

function copyBlock(url: string): string {
  return `\`\`\`\n${url.replace(/`/g, "")}\n\`\`\``;
}

export function uptimePercent(project: ProjectTarget, state: ProjectState): number | null {
  const totals = project.checks.reduce(
    (sum, check) => {
      const row = state.checks[check.id];
      return {
        total: sum.total + (row?.totalChecks ?? 0),
        successful: sum.successful + (row?.successfulChecks ?? 0),
      };
    },
    { total: 0, successful: 0 }
  );
  if (totals.total === 0) return null;
  return (totals.successful / totals.total) * 100;
}

function formatWhen(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

function openIncident(project: ProjectTarget, state: ProjectState): { check: CheckTarget; startedAt: string } | null {
  const open = project.checks.flatMap((check) => {
    const row = state.checks[check.id];
    if (!row || row.status !== "offline" || !row.incidentStartedAt) return [];
    return [{ check, startedAt: row.incidentStartedAt }];
  }).sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  return open[0] ?? null;
}

export function durationLabel(startedAt: string, endedAt: string): string {
  const totalSeconds = Math.floor(Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function buildDashboardEmbed(
  project: ProjectTarget,
  state: ProjectState,
  timeZone: string,
  intervalSeconds: number,
  now: Date
): DiscordEmbed {
  const status = overallStatus(project, state);
  const uptime = uptimePercent(project, state);
  const incident = openIncident(project, state);
  const fields = [
    { name: "STATUS", value: overallChip(status), inline: true },
    { name: "UPTIME", value: `\`${uptime === null ? "—" : `${uptime.toFixed(2)}%`}\``, inline: true },
  ];
  for (const check of project.checks) {
    fields.push({
      name: check.name.toUpperCase(),
      value: `${statusChip(state.checks[check.id])}\n${copyBlock(check.url)}`,
      inline: false,
    });
  }
  if (incident) {
    fields.push({
      name: "Incident",
      value: `${incident.check.name} since ${formatWhen(incident.startedAt, timeZone)}\nDuration ${durationLabel(incident.startedAt, now.toISOString())}`,
      inline: false,
    });
  }
  const subtitle = project.environment.length > 0
    ? project.environment.charAt(0).toUpperCase() + project.environment.slice(1)
    : "Production";
  const link = project.checks[0]?.url ?? "";
  return {
    title: project.name,
    url: link,
    description: subtitle,
    color: overallColor(status),
    fields,
    footer: {
      text: `Updated every ${intervalSeconds === 60 ? "minute" : `${intervalSeconds} seconds`} · ${dashboardMarker(project.id)}`,
    },
    timestamp: now.toISOString(),
  };
}

export function buildAlertContent(
  projectName: string,
  checkName: string,
  event: { type: "down" | "recovery" | "reminder"; startedAt: string; resolvedAt?: string },
  service: ServiceState,
  timeZone: string
): string {
  const http = service.lastStatusCode ? `HTTP ${service.lastStatusCode}` : service.lastError ?? "no response";
  if (event.type === "recovery" && event.resolvedAt) {
    const timing = service.lastResponseTimeMs === null ? "" : ` · ${service.lastResponseTimeMs}ms`;
    return [
      `✅ **${projectName}** — ${checkName} recovered`,
      http + timing,
      `Downtime ${durationLabel(event.startedAt, event.resolvedAt)}`,
      `Recovered ${formatWhen(event.resolvedAt, timeZone)}`,
    ].join("\n");
  }
  const title = event.type === "reminder"
    ? `⏳ **${projectName}** — ${checkName} is still down`
    : `🚨 **${projectName}** — ${checkName} is down`;
  return [
    title,
    http,
    `Detected ${formatWhen(event.startedAt, timeZone)}`,
    `Failures ${service.consecutiveFailures} consecutive checks`,
  ].join("\n");
}
