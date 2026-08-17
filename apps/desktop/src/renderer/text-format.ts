import { type RecordValue, type Project } from "./desktop-types";
import type { NavigationSelection, WorkspaceSelection } from "./navigation";

export function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" ? value as RecordValue : null;
}

export function displayProject(project: Project | null | undefined) {
  if (!project) return { name: "", path: "" };
  const chunks = project.replace(/[\\/]+$/, "").split(/[\\/]/);
  return { name: chunks.at(-1) || project, path: project };
}

export function navigationKey(selection: WorkspaceSelection) {
  if (selection.kind === "new") return `new:${selection.draftId || "default"}`;
  if (selection.kind === "project") return `project:${selection.path}`;
  if (selection.kind === "file") {
    return selection.accessToken
      ? `file-access:${selection.accessToken}`
      : `file:${selection.project}:${selection.rel}`;
  }
  if (selection.kind === "studio") return `studio:${selection.id}`;
  if (selection.kind === "terminal") return `terminal:${selection.id}`;
  if (selection.kind === "folder") return `folder:${selection.id}`;
  if (selection.kind === "pull-request") {
    return `pull-request:${selection.project}:${selection.number}:${selection.mode}:${selection.instanceId || "default"}`;
  }
  if (selection.kind === "diff") {
    return `diff:${selection.project}:${selection.source}:${selection.hash || ""}:${selection.rel}`;
  }
  return `session:${selection.id}`;
}

// Every call mints an independent draft tab (Chrome-style Ctrl+N): the unique
// draftId keeps navigationKey distinct so multiple New task tabs can coexist.
export function newDraftSelection(): NavigationSelection {
  return {
    kind: "new",
    draftId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function workspaceInstanceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newStudioSelection(): Extract<WorkspaceSelection, { kind: "studio" }> {
  return { kind: "studio", id: workspaceInstanceId() };
}

export function newTerminalSelection(
  cwd = "",
): Extract<WorkspaceSelection, { kind: "terminal" }> {
  return {
    kind: "terminal",
    id: `term_tab_${workspaceInstanceId()}`,
    ...(cwd ? { cwd } : {}),
  };
}

/** Folder-explorer pane tab: each open mints an independent instance so the
 *  same folder can sit side by side in a split (Q-Dir style). */
export function newFolderSelection(
  path: string,
): Extract<WorkspaceSelection, { kind: "folder" }> {
  return { kind: "folder", id: `folder_tab_${workspaceInstanceId()}`, path };
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
