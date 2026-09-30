import type { CheckResult, CycleEvent, ServiceState } from "./types.js";

export const FAILURES_BEFORE_DOWN = 3;
export const SUCCESSES_BEFORE_RECOVERY = 2;

export function applyCheck(
  previous: ServiceState,
  result: CheckResult,
  now: Date,
  reminderMs: number,
  checkId: string
): { state: ServiceState; event: CycleEvent | null } {
  const checkedAt = now.toISOString();
  const state: ServiceState = {
    ...previous,
    totalChecks: previous.totalChecks + 1,
    lastCheckedAt: checkedAt,
    lastStatusCode: result.statusCode,
    lastResponseTimeMs: result.responseTimeMs,
    lastError: result.error,
  };

  if (result.online) {
    state.successfulChecks = previous.successfulChecks + 1;
    state.consecutiveFailures = 0;
    state.consecutiveSuccesses = previous.consecutiveSuccesses + 1;
    state.lastError = null;

    if (previous.status === "offline" && state.consecutiveSuccesses < SUCCESSES_BEFORE_RECOVERY) {
      state.status = "offline";
      return { state, event: null };
    }

    const startedAt = previous.incidentStartedAt;
    if (previous.status === "offline" && previous.downAlertSent && startedAt) {
      state.status = "online";
      state.downAlertSent = false;
      state.incidentStartedAt = null;
      state.lastReminderAt = null;
      state.pendingAlert = "recovery";
      state.pendingStartedAt = startedAt;
      state.pendingResolvedAt = checkedAt;
      return { state, event: { type: "recovery", checkId, startedAt, resolvedAt: checkedAt } };
    }

    state.status = "online";
    state.incidentStartedAt = null;
    state.downAlertSent = false;
    return { state, event: null };
  }

  state.consecutiveSuccesses = 0;
  state.consecutiveFailures = previous.consecutiveFailures + 1;

  if (state.consecutiveFailures < FAILURES_BEFORE_DOWN) {
    state.status = previous.status === "offline" ? "offline" : previous.status;
    return { state, event: null };
  }

  state.status = "offline";
  const startedAt = previous.incidentStartedAt ?? checkedAt;
  state.incidentStartedAt = startedAt;

  if (!previous.downAlertSent) {
    state.downAlertSent = true;
    state.lastReminderAt = checkedAt;
    state.pendingAlert = "down";
    state.pendingStartedAt = startedAt;
    state.pendingResolvedAt = null;
    return { state, event: { type: "down", checkId, startedAt } };
  }

  state.downAlertSent = true;
  const lastReminder = previous.lastReminderAt ? Date.parse(previous.lastReminderAt) : Date.parse(startedAt);
  const due = reminderMs > 0 && Number.isFinite(lastReminder) && now.getTime() - lastReminder >= reminderMs;
  if (!due) return { state, event: null };

  state.lastReminderAt = checkedAt;
  state.pendingAlert = "reminder";
  state.pendingStartedAt = startedAt;
  state.pendingResolvedAt = null;
  return { state, event: { type: "reminder", checkId, startedAt } };
}
