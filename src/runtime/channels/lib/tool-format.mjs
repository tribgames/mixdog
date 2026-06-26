import { basename } from "path";
import { safeCodeBlock } from "./format.mjs";
import {
  formatToolSurface,
  isExplorerSurface,
  isMemorySurface,
  normalizeToolName,
} from "../../shared/tool-surface.mjs";

// Texts that should never be forwarded to Discord (Claude's internal status lines)
const SKIP_TEXTS = /* @__PURE__ */ new Set([
  "No response requested.",
  "No response requested",
  "Waiting for user response.",
  "Waiting for user response"
]);

/** Hidden tools — skip both tool_use and tool_result */
const HIDDEN_TOOLS = /* @__PURE__ */ new Set([
  "ToolSearch",
  "SendMessage",
  "TeamCreate",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet"
]);

/** Check if a tool name is recall_memory */
function isRecallMemory(name) {
  return formatToolSurface(name, {}).label === "Memory";
}
/** Check if a file path points to a memory file */
function isMemoryFile(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes(".mixdog/projects/") && normalized.includes("/memory/")) return true;
  if (basename(normalized) === "MEMORY.md") return true;
  return false;
}
/** Check if a tool should be hidden */
function isHidden(name) {
  if (HIDDEN_TOOLS.has(name)) return true;
  if (formatToolSurface(name, {}).label === "Memory") return false;
  if (name.includes("plugin_mixdog") && !name.endsWith("recall_memory") || name === "reply" || name === "react" || name === "edit_message" || name === "fetch" || name === "download_attachment") return true;
  return false;
}
/**
 * Build a per-call dedup key for tool-log queue items.
 * Uses the full (unsquished) tool args so that two Reads on distinct files
 * sharing a basename, or two Grep/Glob calls sharing only a pattern prefix,
 * do not collapse onto the same key and suppress the second send.
 * Returns "" to fall back to md5(formatted) at delivery time.
 */
function buildDedupKey(name, input) {
  if (!name || !input || typeof input !== "object") return "";
  switch (name) {
    case "Read":
      return input.file_path ? "read:" + input.file_path : "";
    case "Grep":
      return "grep:" + (input.pattern ?? "") + ":" + (input.path ?? "");
    case "Glob":
      return "glob:" + (input.pattern ?? "") + ":" + (input.path ?? "");
    default:
      return "";
  }
}
/** Build a tool log line from the tool name and input. */
function buildToolLine(name, input, hiddenCheck = isHidden) {
  if (hiddenCheck(name)) return null;
  const surface = formatToolSurface(name, input, { max: 50 });
  const displayName = surface.label;
  const summary = surface.summary;
  let detail = "";
  switch (normalizeToolName(name)) {
    case "bash":
    case "bash_session":
    case "shell_command": {
      const desc = (input?.description || "").substring(0, 50);
      detail = (input?.command || input?.cmd || desc || "").substring(0, 500);
      break;
    }
    case "apply_patch":
      detail = input?.file_path || "";
      break;
    case "agent":
    case "bridge":
    case "task": {
      let d = (input?.prompt || input?.message || "").substring(0, 200);
      const backticks = (d.match(/```/g) || []).length;
      if (backticks % 2 === 1) d += "\n```";
      if (d.length < (input?.prompt || input?.message || "").length) d += "...";
      detail = d;
      break;
    }
    case "teamcreate":
      detail = input?.description || "";
      break;
    default:
      break;
  }
  if (!displayName) return null;
  let toolLine = !summary || displayName === summary ? "\u25CF **" + displayName + "**" : "\u25CF **" + displayName + "** (" + summary + ")";
  if (!isExplorerSurface(displayName) && !isMemorySurface(displayName) && detail && detail !== summary) {
    const lines = detail.substring(0, 500).split("\n");
    const shown = lines.slice(0, 5);
    let block = shown.join("\n");
    if (lines.length > 5) block += "\n... +" + (lines.length - 5) + " lines";
    toolLine += "\n" + safeCodeBlock(block);
  }
  return toolLine;
}

export {
  SKIP_TEXTS,
  HIDDEN_TOOLS,
  isRecallMemory,
  isMemoryFile,
  isHidden,
  buildDedupKey,
  buildToolLine
};
