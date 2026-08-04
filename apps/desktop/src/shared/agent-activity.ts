type AgentRecord = Record<string, unknown>;

export const DESKTOP_TERMINAL_AGENT_STATUS =
  /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/i;

const DESKTOP_ACTIVE_AGENT_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting)$/i;
const DESKTOP_QUEUED_AGENT_STATUS = /^(?:queued|pending|starting)$/i;

function record(value: unknown): AgentRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as AgentRecord
    : {};
}

function statusValues(value: unknown): string[] {
  const entry = record(value);
  return [entry.stage, entry.status]
    .map((status) => String(status || "").trim())
    .filter((status, index, values) => Boolean(status) && values.indexOf(status) === index);
}

export function desktopAgentStatus(value: unknown): string {
  return statusValues(value)[0] || "";
}

export function isTerminalDesktopAgentEntry(value: unknown): boolean {
  return statusValues(value).some((status) => DESKTOP_TERMINAL_AGENT_STATUS.test(status));
}

export function isActiveDesktopAgentEntry(value: unknown): boolean {
  const statuses = statusValues(value);
  return statuses.length > 0
    && !statuses.some((status) => DESKTOP_TERMINAL_AGENT_STATUS.test(status))
    && statuses.some((status) => DESKTOP_ACTIVE_AGENT_STATUS.test(status));
}

export function isQueuedDesktopAgentEntry(value: unknown): boolean {
  const statuses = statusValues(value);
  return isActiveDesktopAgentEntry(value)
    && statuses.every((status) => DESKTOP_QUEUED_AGENT_STATUS.test(status));
}

export function desktopAgentIdentity(value: unknown): string {
  const entry = record(value);
  return String(entry.tag || entry.task_id || entry.taskId || "").trim();
}
