import type { DiscordEmbed } from "./embed.js";
import { dashboardMarker } from "./types.js";

export class DiscordRequestError extends Error {
  constructor(readonly status: number) {
    super(`Discord request failed with HTTP ${status}`);
    this.name = "DiscordRequestError";
  }
}

interface DiscordMessage {
  id: string;
  embeds?: { footer?: { text?: string } }[];
}

export interface DiscordPublisher {
  publishDashboard(channelId: string, messageId: string | null, embed: DiscordEmbed): Promise<string>;
  publishAlert(channelId: string, messageId: string | null, content: string): Promise<string>;
}

export class DiscordClient implements DiscordPublisher {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`https://discord.com/api/v10${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${this.token}`,
        "content-type": "application/json",
        "user-agent": "StatusMonitor (0.1.0)",
        ...init.headers,
      },
    });
    if (!response.ok) throw new DiscordRequestError(response.status);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async findDashboardMessages(channelId: string): Promise<Map<string, string>> {
    const messages = await this.request<DiscordMessage[]>(`/channels/${channelId}/messages?limit=100`);
    const found = new Map<string, string>();
    for (const message of messages) {
      const footer = message.embeds?.map((embed) => embed.footer?.text ?? "").find((text) => text.includes("status-monitor:"));
      if (!footer) continue;
      const match = /status-monitor:([a-z0-9-]+)/.exec(footer);
      const projectId = match?.[1];
      if (!projectId || found.has(projectId)) continue;
      if (!footer.includes(dashboardMarker(projectId))) continue;
      found.set(projectId, message.id);
    }
    return found;
  }

  async publishDashboard(channelId: string, messageId: string | null, embed: DiscordEmbed): Promise<string> {
    const body = JSON.stringify({ embeds: [embed] });
    if (messageId) {
      try {
        const edited = await this.request<DiscordMessage>(`/channels/${channelId}/messages/${messageId}`, {
          method: "PATCH",
          body,
        });
        return edited.id;
      } catch (error) {
        if (!(error instanceof DiscordRequestError) || error.status !== 404) throw error;
      }
    }
    const created = await this.request<DiscordMessage>(`/channels/${channelId}/messages`, { method: "POST", body });
    return created.id;
  }

  async publishAlert(channelId: string, messageId: string | null, content: string): Promise<string> {
    const body = JSON.stringify({ content });
    if (messageId) {
      try {
        const edited = await this.request<DiscordMessage>(`/channels/${channelId}/messages/${messageId}`, {
          method: "PATCH",
          body,
        });
        return edited.id;
      } catch (error) {
        if (!(error instanceof DiscordRequestError) || error.status !== 404) throw error;
        // message was deleted out from under us — fall through and post a fresh one
      }
    }
    const created = await this.request<DiscordMessage>(`/channels/${channelId}/messages`, { method: "POST", body });
    return created.id;
  }
}