import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyFleetState, emptyServiceState, type FleetState, type ProjectState, type ServiceState } from "./types.js";

function isServiceState(value: unknown): value is ServiceState {
  if (!value || typeof value !== "object") return false;
  const state = value as ServiceState;
  return (
    typeof state.totalChecks === "number" &&
    typeof state.successfulChecks === "number" &&
    typeof state.consecutiveFailures === "number" &&
    (state.status === "online" || state.status === "offline" || state.status === "unknown")
  );
}

function parseProject(value: unknown): ProjectState {
  const project: ProjectState = { messageId: null, checks: {} };
  if (!value || typeof value !== "object") return project;
  const record = value as Partial<ProjectState>;
  project.messageId = typeof record.messageId === "string" ? record.messageId : null;
  if (!record.checks || typeof record.checks !== "object") return project;
  for (const [id, candidate] of Object.entries(record.checks)) {
    if (!isServiceState(candidate)) continue;
    project.checks[id] = { ...emptyServiceState(), ...candidate };
  }
  return project;
}

export function parseState(raw: string): FleetState {
  const parsed: unknown = JSON.parse(raw);
  const fresh = emptyFleetState();
  if (!parsed || typeof parsed !== "object") return fresh;
  const projects = (parsed as Partial<FleetState>).projects;
  if (!projects || typeof projects !== "object") return fresh;
  for (const [id, project] of Object.entries(projects)) {
    fresh.projects[id] = parseProject(project);
  }
  return fresh;
}

export async function loadState(filePath: string): Promise<FleetState> {
  try {
    return parseState(await readFile(filePath, "utf8"));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return emptyFleetState();
    throw error;
  }
}

export async function saveState(filePath: string, state: FleetState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), "utf8");
  await rename(temporary, filePath);
}

export function stateFilePath(dataDir: string): string {
  return path.join(dataDir, "state.json");
}
