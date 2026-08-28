import { type TranscriptItem } from "./desktop-types";
import { t } from "./i18n";
import { asRecord, oneLine } from "./text-format";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { aggregateToolCategoryEntry, classifyToolCategory, formatToolSurface, toolLoadingTargets } from "../../../../src/runtime/shared/tool-surface.mjs";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { parseMcpToolName, titleCaseMcpServer } from "../../../../src/runtime/shared/tool-primitives.mjs";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { deriveToolOutcomeTone } from "../../../../src/runtime/shared/tool-card-model.mjs";

export interface ToolCardModel {
  pending: boolean;
  labelText: string;
  summaryText: string;
  headerFailureText: string;
  detailLine: string;
  detailIsPlaceholder: boolean;
  terminalStatus: string;
}

export function boundedTextOf(value: unknown, maxLength = 100_000) {
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}\n…truncated` : value;
  let visited = 0;
  try {
    const text = JSON.stringify(value, (_key, nested) => {
      visited += 1;
      if (visited > 2_000) return "…truncated";
      if (typeof nested === "string" && nested.length > 20_000) return `${nested.slice(0, 20_000)}…`;
      return nested;
    }, 2) || "";
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n…truncated` : text;
  } catch {
    return oneLine(String(value), maxLength);
  }
}

export function toolResultText(item: TranscriptItem) {
  return [item.result, item.rawResult]
    .filter((value, index, values) => value != null && (index === 0 || value !== values[0]))
    .map(String).join("\n").trim();
}

export function isHookApprovalDenialToolItem(item: TranscriptItem) {
  if (!item.isError) return false;
  const text = toolResultText(item);
  return /^Error:\s*tool\s*"[^"]*"\s*denied by hook\b/im.test(text)
    || /denied by hook:\s*approval required but no approval UI is available/i.test(text);
}

export function shouldSuppressFullyFailedToolItem(item: TranscriptItem) {
  const args = asRecord(item.args);
  const status = String(args?.status || "").toLowerCase();
  if ((args?.task_id || args?.taskId) && /^(failed|error|timeout|cancelled|canceled|killed)$/.test(status)) return false;
  const count = Math.max(1, Number(item.count || 1));
  const completed = Math.max(0, Math.min(count, Number(item.completedCount || (item.result == null ? 0 : count))));
  const explicit = Number(item.errorCount);
  const errors = Number.isFinite(explicit) ? Math.max(0, Math.min(count, Math.floor(explicit))) : item.isError ? count : 0;
  return completed >= count && errors >= count && !isHookApprovalDenialToolItem(item) && !toolResultText(item);
}

export function toolItemDone(item: TranscriptItem): boolean {
  return item.completedAt != null || (item.completedCount === undefined
    ? item.result != null || item.rawResult != null
    : item.completedCount >= (item.count || 1));
}

export function toolActivityItemTone(item: TranscriptItem): "error" | "warning" | "neutral" {
  const count = Math.max(1, Math.round(Number(item.count || 1)));
  const callFailedCount = Math.max(0, Number(item.callErrorCount || 0));
  const exitFailedCount = Math.max(0, Number(item.exitErrorCount || 0));
  const partialMutation = callFailedCount > 0
    && typeof item.uiDiff === "string"
    && Boolean(item.uiDiff.trim());
  const tone = deriveToolOutcomeTone({
    pending: !toolItemDone(item),
    groupCount: count,
    callFailedCount,
    exitFailedCount,
    terminalStatus: isHookApprovalDenialToolItem(item) ? "denied" : "",
    partialMutation,
  });
  return tone === "error" ? "error" : tone === "warning" ? "warning" : "neutral";
}

function localizedToolActivityCategory(category: string): string {
  if (category === "Read") return t("File reading");
  if (category === "Search") return t("Search");
  if (category === "Load") return t("Tool loading");
  if (category === "MCP") return t("MCP tools");
  if (category === "Skill") return t("Skills");
  if (category === "Web Research") return t("Web research");
  if (category === "Memory") return t("Memory");
  if (category === "Patch") return t("File editing");
  if (category === "Git") return t("Git");
  if (category === "Shell") return t("Command execution");
  if (category === "Agent") return t("Agents");
  if (category === "Task") return t("Tasks");
  if (category === "Setup") return t("Setup");
  if (category === "Browser") return t("Browser control");
  if (category === "Computer") return t("Computer control");
  if (category === "Office") return t("Document work");
  return t("External tools");
}

function toolActivityUnitKey(category: string, done: string, noun: string): string {
  return category === "MCP" ? "MCP" : `${category}|${done}|${noun}`;
}

function localizedToolActivityUnit(category: string, done: string, noun: string): string {
  switch (toolActivityUnitKey(category, done, noun)) {
    case "Read|Read|file": return t("File reading");
    case "Read|Read|image": return t("Image viewing");
    case "Read|Read|resource": return t("MCP resource reading");
    case "Read|Read|code map": return t("Code structure");
    case "Search|Searched|pattern": return t("Content search");
    case "Search|Found|glob": return t("File lookup");
    case "Search|Found|query": return t("Path lookup");
    case "Search|Listed|directory": return t("Folder listing");
    case "Search|Mapped|symbol": return t("Symbol lookup");
    case "Patch|Created|file": return t("File creation");
    case "Patch|Edited|file": return t("File editing");
    case "Patch|Deleted|file": return t("File deletion");
    case "Patch|Changed|file": return t("File changes");
    case "Patch|Checked|file": return t("Patch check");
    case "Load|Loaded|tool":
    case "Load|Loaded|query": return t("Tool loading");
    case "Skill|Loaded|skill": return t("Skills");
    case "MCP": return t("MCP tool use");
    case "Web Research|Researched|query": return t("Web search");
    case "Web Research|Fetched|URL": return t("Page fetching");
    case "Web Research|Fetched|message": return t("Message fetching");
    case "Memory|Checked|memory item": return t("Memory lookup");
    case "Memory|Wrote|memory item": return t("Memory saving");
    case "Shell|Ran|command": return t("Command execution");
    case "Git|Ran|Git command": return t("Git commands");
    case "Git|Staged|change": return t("Git staging");
    case "Agent|Called|agent": return t("Agent calls");
    case "Agent|Completed|agent": return t("Agent responses");
    case "Agent|Failed|agent": return t("Agent failures");
    case "Agent|Cancelled|agent": return t("Agent cancellations");
    case "Task|Checked|task": return t("Task status");
    case "Task|Waited for|task": return t("Task waiting");
    case "Task|Listed|task": return t("Task listing");
    case "Task|Cancelled|task": return t("Task cancellation");
    case "Setup|Set|working directory": return t("Project selection");
    case "Setup|Checked|working directory": return t("Project check");
    case "Setup|Asked|user": return t("User questions");
    case "Setup|Updated|plan": return t("Plan updates");
    case "Setup|Listed|MCP resource": return t("MCP resource listing");
    case "Setup|Listed|MCP resource template": return t("MCP template listing");
    default: return localizedToolActivityCategory(category);
  }
}

function namedToolActivityUnit(
  name: unknown,
  args: unknown,
  category: string,
  done: string,
  noun: string,
): { unitKey: string; label: string } {
  const modeledName = desktopToolActivityModeledName(name, args);
  const surface = formatToolSurface(modeledName, args);
  if (category === "MCP") {
    const mcp = parseMcpToolName(String(name || modeledName));
    const server = titleCaseMcpServer(mcp?.server || "");
    if (server) return { unitKey: `MCP|${mcp.server}`, label: server };
  }
  if (category === "Skill") {
    const skills = toolLoadingTargets(modeledName, surface.args);
    const skill = skills.join(", ");
    if (skill) return { unitKey: `Skill|${skill}`, label: skill };
  }
  if (category === "Browser" || category === "Computer" || category === "Office") {
    return { unitKey: category, label: localizedToolActivityCategory(category) };
  }
  if (category === "Other") {
    const label = String(surface.label || modeledName || t("Tool"));
    return { unitKey: `Other|${surface.normalizedName}`, label };
  }
  return {
    unitKey: toolActivityUnitKey(category, done, noun),
    label: localizedToolActivityUnit(category, done, noun),
  };
}

export function flattenedToolActivityItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  const flattened: TranscriptItem[] = [];
  for (const item of items) {
    const members = item.aggregate === true && Array.isArray(item.toolMembers)
      ? item.toolMembers
      : [];
    if (members.length === 0) {
      flattened.push(item);
      continue;
    }
    members.forEach((member, index) => {
      if (!member || typeof member !== "object" || Array.isArray(member)) return;
      const record = member as TranscriptItem;
      flattened.push({
        ...record,
        kind: "tool",
        id: record.id ?? `${String(item.id ?? "aggregate")}:member:${index}`,
      });
    });
  }
  return flattened;
}

const DESKTOP_TOOL_ACTIVITY_ALIASES = new Map([
  ["webfetch", "web_fetch"],
  ["websearch", "web_search"],
  ["patch", "apply_patch"],
  ["write", "edit"],
  ["question", "request_user_input"],
  ["todowrite", "update_plan"],
]);

export function desktopToolActivityModeledName(name: unknown, args: unknown): string {
  const surface = formatToolSurface(String(name || "tool"), args);
  return DESKTOP_TOOL_ACTIVITY_ALIASES.get(surface.normalizedName)
    ?? String(name || "tool");
}

export function desktopToolActivityCategory(name: unknown, args: unknown): string {
  const modeledName = desktopToolActivityModeledName(name, args);
  const surface = formatToolSurface(modeledName, args);
  if (surface.normalizedName === "browser") return "Browser";
  if (surface.normalizedName === "computer") return "Computer";
  if (surface.normalizedName === "office") return "Office";
  return String(classifyToolCategory(modeledName, surface.args) || "Other");
}

export function desktopToolActivityUnit(name: unknown, args: unknown): {
  category: string;
  done: string;
  noun: string;
  unitKey: string;
  label: string;
} {
  const modeledName = desktopToolActivityModeledName(name, args);
  const surface = formatToolSurface(modeledName, args);
  const category = desktopToolActivityCategory(modeledName, surface.args);
  const entry = aggregateToolCategoryEntry(modeledName, surface.args, category) as {
    done?: string;
    noun?: string;
  } | null;
  const done = String(entry?.done || "");
  const noun = String(entry?.noun || "");
  const named = namedToolActivityUnit(name, args, category, done, noun);
  return { category, done, noun, unitKey: named.unitKey, label: named.label };
}

export function desktopToolActivityCategoryGroups(items: readonly TranscriptItem[]) {
  const groups = new Map<string, {
    unitKey: string;
    category: string;
    label: string;
    count: number;
    items: TranscriptItem[];
  }>();
  for (const item of flattenedToolActivityItems(items)) {
    const unit = desktopToolActivityUnit(item.name, item.args);
    const count = Math.max(1, Math.round(Number(item.count || 1)));
    const previous = groups.get(unit.unitKey);
    if (previous) {
      previous.count += count;
      previous.items.push(item);
      continue;
    }
    groups.set(unit.unitKey, {
      unitKey: unit.unitKey,
      category: unit.category,
      label: unit.label,
      count,
      items: [item],
    });
  }
  return [...groups.values()];
}
