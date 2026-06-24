import { basename } from "path";
import { safeCodeBlock } from "./format.mjs";

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
  return name === "recall_memory"
    || name === "mcp__plugin_mixdog_mixdog__recall_memory"
    || name === "mcp__plugin_mixdog_trib-plugin__recall_memory";
}
/** Check if a file path points to a memory file */
function isMemoryFile(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes(".claude/projects/") && normalized.includes("/memory/")) return true;
  if (basename(normalized) === "MEMORY.md") return true;
  return false;
}
/** Check if a tool should be hidden */
function isHidden(name) {
  if (HIDDEN_TOOLS.has(name)) return true;
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
  let displayName = name;
  let summary = "";
  let detail = "";
  const isSearchTool = name === "Read" || name === "Grep" || name === "Glob";
  switch (name) {
    case "Bash": {
      const desc = (input?.description || "").substring(0, 50);
      summary = desc || "Bash";
      detail = (input?.command || "").substring(0, 500);
      break;
    }
    case "Read":
      summary = input?.file_path ? basename(input.file_path) : "";
      break;
    case "Grep":
      summary = '"' + (input?.pattern || "").substring(0, 25) + '"';
      break;
    case "Glob":
      summary = (input?.pattern || "").substring(0, 25);
      break;
    case "Edit":
    case "Write":
      summary = input?.file_path ? basename(input.file_path) : "";
      detail = input?.file_path || "";
      break;
    case "Agent": {
      summary = input?.name || input?.subagent_type || "agent";
      let d = (input?.prompt || "").substring(0, 200);
      const backticks = (d.match(/```/g) || []).length;
      if (backticks % 2 === 1) d += "\n```";
      if (d.length < (input?.prompt || "").length) d += "...";
      detail = d;
      break;
    }
    case "TeamCreate":
      summary = input?.team_name || "";
      detail = input?.description || "";
      break;
    case "TaskCreate":
      summary = (input?.subject || "").substring(0, 50);
      break;
    case "Skill":
      summary = input?.skill || "";
      break;
    default:
      if (name.startsWith("mcp__")) {
        const parts = name.split("__");
        displayName = "mcp";
        summary = parts[parts.length - 1] || "";
      } else {
        summary = name;
      }
      break;
  }
  if (!summary) return null;
  let toolLine = displayName === summary ? "\u25CF **" + displayName + "**" : "\u25CF **" + displayName + "** (" + summary + ")";
  if (!isSearchTool && detail && detail !== summary) {
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
