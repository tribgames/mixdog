/**
 * src/ui/tool-card.mjs — compact one-line cards for tool calls.
 *
 * Replaces the raw `[tool: name]` line with a styled card that shows the tool
 * name plus a short, human-readable summary of its most relevant argument
 * (path for read/write/edit, command for bash, pattern for grep, etc.).
 *
 * Pure formatting: returns a string, never touches stdout. Robust to missing or
 * malformed argument objects (the engine hands us `{ name, arguments, id }`).
 */
import { bold, dim, cyan, gray, yellow, green } from './ansi.mjs';

const MAX_SUMMARY = 72;

/** Map of tool name -> function deriving its one-line summary from args. */
const SUMMARIZERS = {
  read: (a) => a.path ?? a.file,
  write: (a) => a.path,
  apply_patch: (a) => a.path ?? a.base_path ?? firstPatchPath(a.patch),
  edit: (a) => a.path ?? (Array.isArray(a.edits) ? a.edits[0]?.path : undefined),
  list: (a) => a.path ?? a.pattern,
  glob: (a) => joinMaybe(a.pattern) ?? a.path,
  grep: (a) => joinMaybe(a.pattern),
  bash: (a) => a.command,
  diagnostics: (a) => a.path,
};

/**
 * Render a single tool call as a compact card line (no trailing newline).
 * @param {{ name?: string, arguments?: object }} call
 * @returns {string}
 */
export function renderToolCard(call) {
  const name = String(call?.name ?? 'tool');
  let args = call?.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = { _raw: args }; }
  }
  if (!args || typeof args !== 'object') args = {};

  const summary = safeSummary(name, args);
  const bullet = cyan('▸');
  const label = bold(name);
  if (!summary) return `  ${bullet} ${label}`;
  return `  ${bullet} ${label} ${gray(truncate(summary, MAX_SUMMARY))}`;
}

/** Render several calls (from one iteration) as a joined block. */
export function renderToolCards(calls) {
  return (calls || []).map(renderToolCard).join('\n');
}

/** A small "done" marker line for a completed tool (optional nicety). */
export function renderToolResult(name, { ok = true, note = '' } = {}) {
  const mark = ok ? green('✓') : yellow('✗');
  const tail = note ? ' ' + dim(truncate(String(note), 48)) : '';
  return `  ${mark} ${dim(String(name ?? 'tool'))}${tail}`;
}

// --- helpers -----------------------------------------------------------------

function safeSummary(name, args) {
  try {
    const fn = SUMMARIZERS[name];
    let v = fn ? fn(args) : undefined;
    if (v == null) v = firstStringArg(args);
    if (v == null) return '';
    return collapse(String(v));
  } catch {
    return '';
  }
}

function joinMaybe(v) {
  if (Array.isArray(v)) return v.join(' ');
  return v == null ? undefined : v;
}

function firstStringArg(args) {
  for (const key of Object.keys(args)) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return `${key}=${v}`;
  }
  return undefined;
}

function firstPatchPath(patch) {
  if (typeof patch !== 'string') return undefined;
  const m = /\*\*\* (?:Update|Add|Delete) File:\s*(.+)/.exec(patch);
  return m ? m[1].trim() : undefined;
}

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s, max) {
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + '…';
}
