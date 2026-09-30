import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { runCycle } from "./cycle.js";
import { DiscordClient } from "./discord.js";
import { startHealthServer } from "./health-server.js";
import { logger } from "./logger.js";
import { loadState, saveState, stateFilePath } from "./store.js";
import { emptyProjectState } from "./types.js";

function loadLocalEnv(): void {
  if (!existsSync(".env")) return;
  process.loadEnvFile(".env");
}

async function main(): Promise<void> {
  loadLocalEnv();
  const config = await loadConfig();
  const server = await startHealthServer(config.port);
  const discord = new DiscordClient(config.discordToken);
  const filePath = stateFilePath(config.dataDir);
  let state = await loadState(filePath);

  const channels = [...new Set(config.projects.map((project) => project.statusChannelId))];
  for (const channelId of channels) {
    try {
      const found = await discord.findDashboardMessages(channelId);
      for (const project of config.projects) {
        if (project.statusChannelId !== channelId) continue;
        const current = state.projects[project.id];
        if (current?.messageId) continue;
        const messageId = found.get(project.id);
        if (!messageId) continue;
        const next = current ?? emptyProjectState();
        next.messageId = messageId;
        state.projects[project.id] = next;
      }
    } catch (error) {
      logger.error("dashboard_lookup_failed", {
        channelId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  let running = false;
  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      state = await runCycle(config, state, discord);
      await saveState(filePath, state);
    } catch (error) {
      logger.error("cycle_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, config.checkIntervalSeconds * 1000);
  void tick();

  function shutdown(): void {
    clearInterval(timer);
    server.close();
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  logger.info("monitoring_started", {
    port: config.port,
    projects: config.projects.length,
    intervalSeconds: config.checkIntervalSeconds,
  });
}

main().catch((error: unknown) => {
  logger.error("monitor_exited", {
    message: error instanceof Error ? error.message : "unknown",
  });
  process.exitCode = 1;
});
