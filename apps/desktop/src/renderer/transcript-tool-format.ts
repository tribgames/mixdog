import { t, tExisting } from "./i18n";
import { formatElapsed, oneLine } from "./text-format";
import { boundedTextOf } from "./transcript-tool-core";

export const TOOL_DETAIL_LABELS = {
  arguments: "Arguments",
  content: "Content",
  before: "Before",
  after: "After",
  answer: "Answer",
  questions: "Questions",
  todos: "Todos",
  plan: "Plan",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
} as const;

const TOOL_ACTIVITY_RESULT_COUNT_KEYS = new Map([
  ["line", "{{count}} lines"],
  ["lines", "{{count}} lines"],
  ["match", "{{count}} matches"],
  ["matches", "{{count}} matches"],
  ["file", "{{count}} files"],
  ["files", "{{count}} files"],
  ["entry", "{{count}} entries"],
  ["entries", "{{count}} entries"],
  ["candidate", "{{count}} candidates"],
  ["candidates", "{{count}} candidates"],
  ["result", "{{count}} results"],
  ["results", "{{count}} results"],
  ["skill", "{{count}} skills"],
  ["skills", "{{count}} skills"],
  ["memory", "{{count}} memories"],
  ["memories", "{{count}} memories"],
  ["message", "{{count}} messages"],
  ["messages", "{{count}} messages"],
  ["agent", "{{count}} agents"],
  ["agents", "{{count}} agents"],
  ["task", "{{count}} tasks"],
  ["tasks", "{{count}} tasks"],
  ["reference", "{{count}} references"],
  ["references", "{{count}} references"],
  ["definition", "{{count}} definitions"],
  ["definitions", "{{count}} definitions"],
  ["symbol", "{{count}} symbols"],
  ["symbols", "{{count}} symbols"],
  ["caller", "{{count}} callers"],
  ["callers", "{{count}} callers"],
  ["callee", "{{count}} callees"],
  ["callees", "{{count}} callees"],
]);

const TOOL_ACTIVITY_RESULT_PHRASE_KEYS = new Map([
  ["no results", "No results"],
  ["no result", "No results"],
  ["(no output)", "No output"],
  ["no agents or tasks", "No agents or tasks"],
  ["image", "Image"],
  ["staged", "Staged"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
  ["finished", "Finished"],
]);

export function toolActivityLocalizedResult(text: string): string {
  const value = text.trim();
  if (!value || value.length > 120) return text;
  return value.split(" · ").map((part) => {
    const counted = /^(\d+)\s+([A-Za-z]+)$/.exec(part);
    if (counted) {
      const key = TOOL_ACTIVITY_RESULT_COUNT_KEYS.get(counted[2].toLowerCase());
      if (key) return tExisting(key, part, { count: Number(counted[1]) });
    }
    const exit = /^Exit\s+(\S+)$/i.exec(part);
    if (exit) return tExisting("Exit {{code}}", part, { code: exit[1] });
    const skill = /^(Loaded|Used)\s+(.+)$/.exec(part);
    if (skill) {
      return tExisting(
        skill[1] === "Loaded" ? "Loaded {{name}}" : "Used {{name}}",
        part,
        { name: skill[2] },
      );
    }
    const phrase = TOOL_ACTIVITY_RESULT_PHRASE_KEYS.get(part.toLowerCase());
    return phrase ? tExisting(phrase, part) : part;
  }).join(" · ");
}

const TOOL_ACTIVITY_CODE_LANGUAGES = new Map([
  ["ts", "ts"], ["tsx", "tsx"], ["mts", "ts"], ["cts", "ts"],
  ["js", "js"], ["jsx", "jsx"], ["mjs", "js"], ["cjs", "js"],
  ["json", "json"], ["jsonc", "json"], ["json5", "json"],
  ["css", "css"], ["scss", "scss"], ["less", "less"],
  ["html", "html"], ["htm", "html"], ["xml", "xml"], ["svg", "xml"],
  ["md", "markdown"], ["markdown", "markdown"], ["mdx", "markdown"],
  ["py", "python"], ["rb", "ruby"], ["php", "php"], ["java", "java"],
  ["kt", "kotlin"], ["kts", "kotlin"], ["swift", "swift"], ["go", "go"],
  ["rs", "rust"], ["c", "c"], ["h", "c"], ["cpp", "cpp"], ["cc", "cpp"],
  ["hpp", "cpp"], ["cs", "csharp"], ["sql", "sql"], ["lua", "lua"],
  ["sh", "bash"], ["bash", "bash"], ["zsh", "bash"], ["ps1", "powershell"],
  ["psm1", "powershell"], ["yml", "yaml"], ["yaml", "yaml"], ["toml", "toml"],
  ["ini", "ini"], ["dockerfile", "dockerfile"], ["gradle", "gradle"],
  ["vue", "html"], ["svelte", "html"],
]);

export function toolActivityCodeLanguage(pathText: string): string {
  const name = String(pathText || "").trim().replace(/[\\/]+$/, "");
  if (!name) return "";
  const base = name.split(/[\\/]/).pop() || "";
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  const extension = /\.([A-Za-z0-9]+)$/.exec(base);
  return extension
    ? TOOL_ACTIVITY_CODE_LANGUAGES.get(extension[1].toLowerCase()) || ""
    : "";
}

export const TOOL_ACTIVITY_INTERNAL_ARGS = new Set([
  "categoryOrder",
  "loadingTargets",
  "agentBatch",
  "verifyShell",
]);

export const TOOL_ACTIVITY_BULK_ARGS = new Set([
  "old_string",
  "new_string",
  "oldString",
  "newString",
  "old_str",
  "new_str",
  "content",
  "patch",
]);

const TOOL_ACTIVITY_SECRET_ARG = /(?:password|secret|token|api[_-]?key|authorization|cookie)/i;
export const TOOL_ACTIVITY_ROUTINE_RESULT = /^(?:ok|done|success(?:ful)?|completed|finished|updated|written|applied|saved|loaded|cancelled)[.!]?$/i;
export const TOOL_ACTIVITY_MEANINGLESS_RESULT = /^(?:ok|done|success(?:ful)?|completed|finished|updated|written|applied|loaded)[.!]?$/i;

export function toolActivityInline(value: unknown, max = 500): string {
  return oneLine(boundedTextOf(value, max)).trim();
}

export function toolActivityFirstText(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function toolActivityStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter(Boolean);
}

export function toolActivityCompact(parts: Array<string | undefined>): string {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join(" · ");
}

function toolActivityQuoted(value: unknown): string {
  const text = toolActivityInline(value, 300);
  return text ? `"${text}"` : "";
}

export function toolActivityCommand(args: Record<string, unknown>): string {
  const direct = toolActivityFirstText(args, "command", "cmd", "description");
  if (direct) return direct;
  const commands = toolActivityStringList(args.commands);
  return commands.join("\n");
}

function toolActivityPath(args: Record<string, unknown>): string {
  return toolActivityFirstText(args, "file_path", "filePath", "path", "file", "target");
}

export function toolActivitySubject(
  normalizedName: string,
  args: Record<string, unknown>,
  fallback: string,
): string {
  const path = toolActivityPath(args);
  switch (normalizedName) {
    case "read": {
      const paths = toolActivityStringList(args.file_path ?? args.path);
      const target = paths.length > 1 ? `${paths.length} files` : path;
      const offset = Number(args.offset);
      const limit = Number(args.limit);
      const window = Number.isFinite(offset) && offset > 0 && Number.isFinite(limit) && limit > 0
        ? `lines ${offset}-${offset + limit - 1}`
        : Number.isFinite(offset) && offset > 0
          ? `from line ${offset}`
          : Number.isFinite(limit) && limit > 0 ? `${limit} lines` : "";
      return toolActivityCompact([target, window]);
    }
    case "view_image":
    case "read_mcp_resource":
      return path || toolActivityFirstText(args, "uri");
    case "edit":
    case "strreplace":
    case "str_replace":
    case "str_replace_editor":
    case "search_replace":
      return path;
    case "apply_patch":
      return fallback;
    case "shell":
    case "bash":
    case "bash_session":
    case "shell_command":
    case "job_wait":
    case "git":
      return toolActivityInline(toolActivityCommand(args), 1_000);
    case "git_stage": {
      const files = toolActivityStringList(args.files ?? args.paths);
      return files.length > 2 ? `${files.length} files` : files.join(", ");
    }
    case "grep": {
      const patterns = toolActivityStringList(args.pattern ?? args.query);
      const pattern = patterns.length > 1
        ? `${patterns.length} patterns`
        : toolActivityQuoted(args.pattern ?? args.query);
      return toolActivityCompact([
        pattern,
        args.path ? `in ${toolActivityInline(args.path)}` : "",
        args.glob ? toolActivityInline(args.glob) : "",
      ]);
    }
    case "glob": {
      const patterns = toolActivityStringList(args.pattern ?? args.glob);
      const pattern = patterns.length > 1
        ? `${patterns.length} globs`
        : toolActivityInline(args.pattern ?? args.glob);
      return toolActivityCompact([pattern, args.path ? `in ${toolActivityInline(args.path)}` : ""]);
    }
    case "find": {
      const queries = toolActivityStringList(args.query ?? args.fuzzy);
      const query = queries.length > 1
        ? `${queries.length} queries`
        : toolActivityQuoted(args.query ?? args.fuzzy);
      return toolActivityCompact([query, args.path ? `in ${toolActivityInline(args.path)}` : ""]);
    }
    case "list":
    case "ls":
      return toolActivityCompact([
        path,
        args.limit ? `${toolActivityInline(args.limit)} entries` : "",
      ]);
    case "web_search":
    case "web_search_call":
    case "search_query":
    case "image_query":
      return toolActivityQuoted(args.query ?? args.keywords);
    case "web_fetch":
    case "fetch":
      return toolActivityInline(args.url ?? args.uri ?? fallback, 1_000);
    case "load_tool": {
      const names = [
        ...toolActivityStringList(args.names),
        ...toolActivityStringList(args.select),
      ];
      return names.join(", ") || fallback;
    }
    case "skill":
    case "skill_execute":
    case "skill_view":
    case "skills_list":
    case "use_skill":
      return toolActivityFirstText(args, "name", "skill", "skill_name", "query") || fallback;
    case "task":
      return toolActivityCompact([
        toolActivityFirstText(args, "action"),
        toolActivityFirstText(args, "task_id", "id"),
      ]);
    case "agent":
    case "bridge":
      return toolActivityFirstText(args, "description", "tag", "role", "model")
        || fallback;
    case "request_user_input": {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      if (!questions.length) return "";
      const count = `${questions.length} ${questions.length === 1 ? "question" : "questions"}`;
      return tExisting("{{count}} questions", count, { count: questions.length });
    }
    case "update_plan":
      return "";
    default:
      return fallback;
  }
}

export function toolActivityTitle(
  normalizedName: string,
  originalName: string,
  surfaceLabel: string,
  args: Record<string, unknown>,
): string {
  if (originalName === "write") return t("Write");
  if (originalName === "question") return t("Questions");
  if (originalName === "todowrite" || Array.isArray(args.todos)) return t("Todos");
  switch (normalizedName) {
    case "read": return t("Read");
    case "view_image": return t("Image");
    case "read_mcp_resource": return t("Resource");
    case "edit":
    case "strreplace":
    case "str_replace":
    case "str_replace_editor":
    case "search_replace":
      return t("Edit");
    case "git":
    case "git_stage":
      return t("Git");
    case "shell":
    case "bash":
    case "bash_session":
    case "shell_command":
    case "job_wait":
      return t("Run");
    case "grep":
    case "glob":
    case "find":
      return t("Search");
    case "list":
    case "ls":
      return t("List");
    case "web_search":
    case "web_search_call":
    case "search_query":
    case "image_query":
      return t("Web Search");
    case "web_fetch":
    case "fetch":
      return t("Fetch");
    case "load_tool": return t("Load");
    case "task": return t("Task");
    case "agent":
    case "bridge":
      return t("Agent");
    case "request_user_input": return t("Questions");
    case "update_plan": return t("Plan");
    case "skill":
    case "skill_execute":
    case "skill_view":
    case "skills_list":
    case "use_skill":
      return t("Skill");
    default:
      return surfaceLabel || originalName || t("Tool");
  }
}

export function toolActivityFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    api_key: "API key",
    include_noise: "Include ignored",
    timeout_ms: "Timeout",
  };
  if (labels[key]) return labels[key];
  const text = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : key;
}

export function toolActivityFieldValue(key: string, value: unknown): string {
  if (TOOL_ACTIVITY_SECRET_ARG.test(key)) return "••••••";
  if (key === "timeout_ms" && Number(value) > 0) {
    return formatElapsed(Number(value));
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join(", ");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2).slice(0, 8_000);
    } catch {}
  }
  return boundedTextOf(value, 8_000);
}

export function toolActivityRedactInlineSecrets(text: string, args: Record<string, unknown>): string {
  let redacted = text;
  for (const [key, value] of Object.entries(args)) {
    if (!TOOL_ACTIVITY_SECRET_ARG.test(key) || value == null || typeof value === "object") continue;
    const raw = toolActivityInline(value);
    if (!raw) continue;
    redacted = redacted
      .split(`${key}=${raw}`).join(`${key}=••••••`)
      .split(`${key}: ${raw}`).join(`${key}: ••••••`);
  }
  return redacted;
}

export function toolActivityRepresentedKeys(normalizedName: string): Set<string> {
  const keys = new Set<string>();
  const add = (...values: string[]) => values.forEach((value) => keys.add(value));
  switch (normalizedName) {
    case "read":
      add("file_path", "filePath", "path", "file", "offset", "limit", "pages");
      break;
    case "view_image":
    case "read_mcp_resource":
      add("file_path", "filePath", "path", "file", "uri");
      break;
    case "edit":
    case "strreplace":
    case "str_replace":
    case "str_replace_editor":
    case "search_replace":
      add("file_path", "filePath", "path", "file", "target");
      break;
    case "shell":
    case "bash":
    case "bash_session":
    case "shell_command":
    case "job_wait":
    case "git":
      add("command", "commands", "cmd", "description");
      break;
    case "git_stage":
      add("files", "paths");
      break;
    case "grep":
      add("pattern", "query", "path", "glob");
      break;
    case "glob":
      add("pattern", "glob", "path");
      break;
    case "find":
      add("query", "fuzzy", "path");
      break;
    case "list":
    case "ls":
      add("path", "dir", "cwd", "limit");
      break;
    case "web_search":
    case "web_search_call":
    case "search_query":
    case "image_query":
      add("query", "keywords");
      break;
    case "web_fetch":
    case "fetch":
      add("url", "uri");
      break;
    case "load_tool":
      add("names", "select", "query", "q", "text");
      break;
    case "skill":
    case "skill_execute":
    case "skill_view":
    case "skills_list":
    case "use_skill":
      add("name", "skill", "skill_name", "query", "q");
      break;
    case "task":
      add("action", "task_id", "id");
      break;
    case "agent":
    case "bridge":
      add("type", "action", "description", "tag", "role", "model", "prompt",
        "status", "task_id", "sessionId");
      break;
    case "request_user_input":
      add("questions", "answers");
      break;
    case "update_plan":
      add("plan", "todos", "explanation");
      break;
    case "memory":
    case "remember":
    case "save_memory":
    case "update_memory":
    case "recall_memory":
    case "recall":
    case "search_memories":
      add("action", "type", "operation", "op", "query", "queries", "text", "input",
        "summary", "element", "key", "name", "value", "limit", "topK");
      break;
    case "code_graph":
      add("mode", "action", "symbols", "symbol", "query", "files", "file", "path",
        "body", "limit", "depth", "cwd");
      break;
    case "cwd":
      add("action", "type", "path", "cwd", "dir");
      break;
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
      add("server");
      break;
  }
  return keys;
}
