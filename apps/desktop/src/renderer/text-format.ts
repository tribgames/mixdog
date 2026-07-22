import { type RecordValue, type Project } from "./desktop-types";
import type { NavigationSelection } from "./navigation";

export function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" ? value as RecordValue : null;
}

export function displayProject(project: Project | null | undefined) {
  if (!project) return { name: "", path: "" };
  const chunks = project.replace(/[\\/]+$/, "").split(/[\\/]/);
  return { name: chunks.at(-1) || project, path: project };
}

export function navigationKey(selection: NavigationSelection) {
  if (selection.kind === "new") return `new:${selection.draftId || "default"}`;
  if (selection.kind === "project") return `project:${selection.path}`;
  return `session:${selection.id}`;
}

// Draft tabs: every + press opens an independent "New task"
// draft tab, so each draft needs its own stable key.
export function newDraftSelection(): NavigationSelection {
  return { kind: "new", draftId: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
}

export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function publicThinkingSummary(value: unknown) {
  const record = asRecord(value);
  if (!record) return "";
  const text = record.publicSummary ?? record.publicReasoningSummary;
  return typeof text === "string" ? text.trim() : "";
}

export function oneLine(value: unknown, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

export function queueText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return String(record?.displayText || record?.text || record?.prompt || "Queued request");
}

export function formatElapsed(value: unknown): string {
  const elapsedMs = Math.max(0, Number(value) || 0);
  if (elapsedMs < 1_000) return "";
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function formatIdleDuration(value: unknown): string {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (!milliseconds) return "provider default";
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export const TURN_LOCKED_SLASH_COMMANDS = new Set([
  "clear",
  "compact",
  "resume",
  "outputstyle",
  "effort",
  "fast",
]);

export async function copyTextToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}
