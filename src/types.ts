export type Importance = "critical" | "dependency";
export type ServiceStatus = "online" | "offline" | "unknown";

export interface CheckTarget {
  id: string;
  name: string;
  url: string;
  importance: Importance;
  expect?: Record<string, string> | undefined;
  apiKey?: string | undefined;
  database?: boolean | undefined;
}

export interface ProjectTarget {
  id: string;
  name: string;
  environment: string;
  statusChannelId: string;
  checks: CheckTarget[];
}

export interface CheckResult {
  online: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  error: string | null;
}

export interface ServiceState {
  totalChecks: number;
  successfulChecks: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  status: ServiceStatus;
  incidentStartedAt: string | null;
  downAlertSent: boolean;
  lastReminderAt: string | null;
  pendingAlert: "down" | "recovery" | "reminder" | null;
  pendingStartedAt: string | null;
  pendingResolvedAt: string | null;
  lastStatusCode: number | null;
  lastResponseTimeMs: number | null;
  lastError: string | null;
  lastCheckedAt: string | null;
}

export interface ProjectState {
  messageId: string | null;
  checks: Record<string, ServiceState>;
}

export interface FleetState {
  projects: Record<string, ProjectState>;
}

export type CycleEvent =
  | { type: "down"; checkId: string; startedAt: string }
  | { type: "recovery"; checkId: string; startedAt: string; resolvedAt: string }
  | { type: "reminder"; checkId: string; startedAt: string };

export function emptyServiceState(): ServiceState {
  return {
    totalChecks: 0,
    successfulChecks: 0,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    status: "unknown",
    incidentStartedAt: null,
    downAlertSent: false,
    lastReminderAt: null,
    pendingAlert: null,
    pendingStartedAt: null,
    pendingResolvedAt: null,
    lastStatusCode: null,
    lastResponseTimeMs: null,
    lastError: null,
    lastCheckedAt: null,
  };
}

export function emptyProjectState(): ProjectState {
  return { messageId: null, checks: {} };
}

export function emptyFleetState(): FleetState {
  return { projects: {} };
}

export function projectStateFor(previous: ProjectState | undefined, checks: CheckTarget[]): ProjectState {
  const next = emptyProjectState();
  next.messageId = previous?.messageId ?? null;
  for (const check of checks) {
    next.checks[check.id] = previous?.checks[check.id] ?? emptyServiceState();
  }
  return next;
}

export function dashboardMarker(projectId: string): string {
  return `status-monitor:${projectId}`;
}
