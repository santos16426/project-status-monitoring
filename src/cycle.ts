import { checkUrl, type CheckOptions } from "./check.js";
import type { MonitorConfig } from "./config.js";
import type { DiscordPublisher } from "./discord.js";
import { buildAlertContent, buildDashboardEmbed } from "./embed.js";
import { applyCheck } from "./evaluate.js";
import { logger } from "./logger.js";
import { emptyFleetState, projectStateFor, type FleetState } from "./types.js";

export async function runCycle(
  config: MonitorConfig,
  fleetState: FleetState,
  discord: DiscordPublisher,
  now = new Date(),
  check: (url: string, options: CheckOptions) => ReturnType<typeof checkUrl> = checkUrl
): Promise<FleetState> {
  const next = emptyFleetState();

  for (const project of config.projects) {
    const projectState = projectStateFor(fleetState.projects[project.id], project.checks);
    next.projects[project.id] = projectState;

    for (const target of project.checks) {
      const result = await check(target.url, {
        timeoutMs: config.requestTimeoutMs,
        retryDelayMs: config.retryDelayMs,
        expect: target.expect,
      });
      const previous = projectState.checks[target.id];
      if (!previous) continue;
      const applied = applyCheck(previous, result, now, config.reminderMs, target.id);
      projectState.checks[target.id] = applied.state;
      logger.info("check_finished", {
        project: project.id,
        check: target.id,
        online: result.online,
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
        alert: applied.event?.type ?? null,
      });
    }

    for (const target of project.checks) {
      const current = projectState.checks[target.id];
      if (!current?.pendingAlert || !current.pendingStartedAt) continue;
      const startedAt = current.pendingStartedAt;
      const resolvedAt = current.pendingResolvedAt;
      const alert = resolvedAt
        ? { type: current.pendingAlert, startedAt, resolvedAt }
        : { type: current.pendingAlert, startedAt };
      try {
        await discord.publishAlert(
          config.alertChannelId ?? project.statusChannelId,
          buildAlertContent(project.name, target.name, alert, current, config.timeZone)
        );
        current.pendingAlert = null;
        current.pendingStartedAt = null;
        current.pendingResolvedAt = null;
      } catch (error) {
        logger.error("alert_failed", {
          project: project.id,
          check: target.id,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    try {
      projectState.messageId = await discord.publishDashboard(
        project.statusChannelId,
        projectState.messageId,
        buildDashboardEmbed(project, projectState, config.timeZone, config.checkIntervalSeconds, now)
      );
    } catch (error) {
      logger.error("dashboard_failed", {
        project: project.id,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return next;
}
