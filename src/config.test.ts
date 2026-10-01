import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";

interface FixtureCheck {
  id: string;
  name: string;
  url: string;
  importance?: string;
  expect?: Record<string, string>;
  apiKey?: string;
  database?: boolean;
}

interface FixtureProject {
  id: string;
  name: string;
  environment?: string;
  discord_status_channel_id?: string;
  checks: FixtureCheck[];
}

const projects: FixtureProject[] = [
  {
    id: "moolah",
    name: "Moolah",
    environment: "production",
    discord_status_channel_id: "323456789012345678",
    checks: [
      { id: "frontend", name: "Frontend", url: "https://moolah.example/" },
      { id: "backend", name: "Backend", url: "https://api.example/health" },
      {
        id: "database",
        name: "Database",
        url: "https://api.example/ready",
        importance: "dependency",
      },
    ],
  },
  {
    id: "planera",
    name: "Planera",
    checks: [{ id: "frontend", name: "Frontend", url: "https://planera.example" }],
  },
];

const baseEnv: NodeJS.ProcessEnv = {
  DISCORD_BOT_TOKEN: "test-token-with-enough-length",
  DISCORD_STATUS_CHANNEL_ID: "123456789012345678",
  PROJECTS_JSON: JSON.stringify(projects),
};

function withProjects(next: unknown, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...baseEnv, ...extra, PROJECTS_JSON: JSON.stringify(next) };
}

describe("loadConfig", () => {
  it("loads moolah and planera from PROJECTS_JSON", async () => {
    const config = await loadConfig(baseEnv);
    assert.deepEqual(
      config.projects.map((project) => project.id),
      ["moolah", "planera"]
    );
    const database = config.projects[0]?.checks.find((check) => check.id === "database");
    const frontend = config.projects[0]?.checks.find((check) => check.id === "frontend");
    assert.equal(database?.importance, "dependency");
    assert.equal(database?.expect, undefined);
    assert.equal(frontend?.importance, "critical");
    assert.equal(config.projects[0]?.statusChannelId, "323456789012345678");
    assert.equal(config.projects[1]?.statusChannelId, "123456789012345678");
    assert.equal(config.checkIntervalSeconds, 60);
    assert.equal(config.timeZone, "Asia/Manila");
  });

  it("rejects credentials, a short token, http in production, and duplicate ids", async () => {
    const credentialed = structuredClone(projects);
    const moolah = credentialed[0];
    if (!moolah) throw new Error("missing moolah");
    moolah.checks[1] = {
      id: "backend",
      name: "Backend",
      url: "https://user:secret@api.example/health",
    };
    await assert.rejects(() => loadConfig(withProjects(credentialed)), /credentials/);
    await assert.rejects(
      () => loadConfig({ ...baseEnv, DISCORD_BOT_TOKEN: "short" }),
      /too short/
    );
    const insecure = structuredClone(projects);
    const insecureMoolah = insecure[0];
    if (!insecureMoolah) throw new Error("missing moolah");
    insecureMoolah.checks[0] = {
      id: "frontend",
      name: "Frontend",
      url: "http://moolah.example",
    };
    await assert.rejects(
      () => loadConfig(withProjects(insecure, { NODE_ENV: "production" })),
      /https/
    );
    const duplicated = structuredClone(projects);
    const planera = duplicated[1];
    if (!planera) throw new Error("missing planera");
    planera.id = "moolah";
    await assert.rejects(() => loadConfig(withProjects(duplicated)), /Duplicate project id/);

    const health = structuredClone(projects);
    const healthProject = health[0];
    if (!healthProject) throw new Error("missing project");
    healthProject.checks[1] = {
      id: "backend",
      name: "Backend",
      url: "https://api.example/health",
      expect: { status: "ok", db: "up" },
    };
    const loaded = await loadConfig(withProjects(health));
    assert.deepEqual(loaded.projects[0]?.checks[1]?.expect, { status: "ok", db: "up" });
    healthProject.checks[1] = {
      id: "backend",
      name: "Backend",
      url: "https://api.example/health",
      expect: { Status: "ok" },
    };
    await assert.rejects(() => loadConfig(withProjects(health)), /lowercase/);
    healthProject.checks[1] = {
      id: "backend",
      name: "Backend",
      url: "https://api.example/health?apikey=token",
      apiKey: "anon-key-0123456789abcdef",
    };
    await assert.rejects(() => loadConfig(withProjects(health)), /api key/);
  });
});
