const RECOVERY_WINDOW_MS = 60_000;
const AUTO_RELOAD_LIMIT = 2;
const RECOVERABLE_REASONS = new Set([
  "abnormal-exit",
  "crashed",
  "oom",
  "launch-failed",
  "integrity-failure",
]);

export interface RendererRecoveryDecision {
  failures: number[];
  action: "none" | "reload" | "prompt";
}

export function rendererRecoveryDecision(
  previousFailures: readonly number[],
  reason: string,
  now = Date.now(),
): RendererRecoveryDecision {
  const failures = previousFailures.filter((at) =>
    Number.isFinite(at) && now >= at && now - at < RECOVERY_WINDOW_MS);
  if (!RECOVERABLE_REASONS.has(reason)) return { failures, action: "none" };
  failures.push(now);
  return {
    failures,
    action: failures.length <= AUTO_RELOAD_LIMIT ? "reload" : "prompt",
  };
}

function token(value: unknown, fallback: string, limit = 80): string {
  const normalized = String(value || "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, limit);
  return normalized || fallback;
}

function sourceName(value: unknown): string {
  const text = String(value || "").split(/[?#]/, 1)[0];
  const name = text.split(/[\\/]/).at(-1) || "";
  return token(name, "", 120);
}

function boundedCoordinate(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(10_000_000, Math.max(0, Math.floor(numeric)));
}

function componentToken(value: unknown): string {
  const text = String(value || "").trim();
  return /^[A-Za-z][A-Za-z0-9_.$:-]{0,79}$/.test(text) ? text : "";
}

export function normalizeRendererDiagnostic(input: unknown): Record<string, unknown> {
  const record = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  const allowedPhases = new Set(["boundary", "window-error", "unhandled-rejection"]);
  const phase = allowedPhases.has(String(record.phase)) ? String(record.phase) : "unknown";
  const details: Record<string, unknown> = {
    phase,
    errorName: token(record.errorName, "Unknown"),
    fingerprint: /^[a-f0-9]{8}$/i.test(String(record.fingerprint || ""))
      ? String(record.fingerprint).toLowerCase()
      : "00000000",
  };
  const source = sourceName(record.source);
  const line = boundedCoordinate(record.line);
  const column = boundedCoordinate(record.column);
  const failureCode = componentToken(record.failureCode);
  const components = Array.isArray(record.components)
    ? record.components.map(componentToken).filter(Boolean).slice(0, 12)
    : [];
  if (failureCode) details.failureCode = failureCode;
  if (components.length) details.components = components;
  if (source) details.source = source;
  if (line !== undefined) details.line = line;
  if (column !== undefined) details.column = column;
  return details;
}

export function normalizeRendererLongTaskDiagnostic(input: unknown): Record<string, unknown> | null {
  const record = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  if (record.kind !== "long-task") return null;
  const durationMs = Number(record.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < 50) return null;
  return {
    durationMs: Math.min(60_000, Math.round(durationMs)),
  };
}

export function normalizeRendererComposerActionDiagnostic(input: unknown): Record<string, unknown> | null {
  const record = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  if (record.kind !== "composer-action") return null;
  const actions = new Set(["submit", "restore-queue"]);
  const sources = new Set([
    "keyboard-enter", "form-submit", "slash-keyboard", "slash-click",
    "escape", "arrow-up", "queue-row",
  ]);
  const action = String(record.action || "");
  const source = String(record.source || "");
  if (!actions.has(action) || !sources.has(source)) return null;
  const metric = (value: unknown, max: number) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(max, Math.max(0, Math.round(numeric))) : 0;
  };
  return {
    action,
    source,
    turnBusy: record.turnBusy === true,
    queueCount: metric(record.queueCount, 10_000),
    draftLength: metric(record.draftLength, 10_000_000),
    composing: record.composing === true,
    uptimeMs: metric(record.uptimeMs, 1_000_000_000),
    ...(record.targeted === true ? { targeted: true } : {}),
  };
}
