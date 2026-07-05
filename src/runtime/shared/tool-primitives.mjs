import { displayModelName as sharedDisplayModelName } from '../../ui/model-display.mjs';

// Default cap for tool-arg summaries (header parenthetical, channel tool lines).
// Unified at 80 so every tool surface line — header arg summary and collapsed
// detail alike — shares one width ceiling; per-call sites still clamp lower
// (header 48, channel 50) where a tighter line is wanted.
export const DEFAULT_SUMMARY_MAX = 80;
// Semantic cap for collapsed tool/agent/task card one-liners — the second row
// under the ⎿ gutter (spawn, send, response, generic/shell result summaries).
// Kept at 80 so every collapsed detail line is truncated to the same width
// regardless of terminal columns; ctrl+o expand still shows the full body.
export const AGENT_SURFACE_BRIEF_MAX = 80;
export const STATUS_SEPARATOR = ' · ';

export function stripToolPrefix(name) {
  const text = rawToolName(name);
  const mcp = parseMcpToolName(text);
  return mcp ? mcp.tool : text;
}

function rawToolName(name) {
  return String(name || 'tool').replace(/^functions\./, '');
}

export function parseMcpToolName(name) {
  const text = rawToolName(name);
  const match = /^mcp__(.+?)__(.+)$/.exec(text);
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}

export function isMcpToolName(name) {
  return Boolean(parseMcpToolName(name));
}

export function normalizeToolName(name) {
  return stripToolPrefix(name).replace(/-/g, '_').toLowerCase();
}

export function truncateToolText(value, max = DEFAULT_SUMMARY_MAX) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function truncateSingleLine(value, max = DEFAULT_SUMMARY_MAX) {
  return truncateToolText(String(value ?? '').replace(/\s+/g, ' '), max);
}

export function truncateCommand(value, max = DEFAULT_SUMMARY_MAX) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const lines = text.split('\n');
  let out = lines.length > 2 ? `${lines.slice(0, 2).join(' ')}...` : lines.join(' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, Math.max(1, max - 3))}...` : out;
}

export function parseToolArgs(args) {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' ? parsed : { value: args };
    } catch {
      return { value: args };
    }
  }
  if (typeof args === 'object') {
    if (args.input && typeof args.input === 'object') return args.input;
    return args;
  }
  return { value: args };
}

export function displayToolPath(path) {
  const text = String(path ?? '');
  return text.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || text;
}

export function compactParts(parts) {
  return parts.filter((part) => part != null && String(part).trim()).map((part) => String(part).trim()).join(STATUS_SEPARATOR);
}

export function compactSlash(left, right) {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  return a && b ? `${a}/${b}` : a || b;
}

export function mcpToolTarget(name, max = DEFAULT_SUMMARY_MAX) {
  const mcp = parseMcpToolName(name);
  if (!mcp) return '';
  return truncateToolText(compactSlash(mcp.server, mcp.tool), max);
}

export function quoted(value, max) {
  const text = truncateToolText(value || '', max);
  return text ? `"${text}"` : '';
}

export function firstText(...values) {
  for (const value of values) {
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

export function splitToolSearchSelection(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toolSearchTargetKind(value) {
  const lower = String(value || '').trim().toLowerCase();
  if (!lower) return '';
  if (lower.startsWith('mcp__') || lower.includes('_mcp_') || lower.includes('mcp')) return 'MCP';
  if (lower === 'skill' || lower.startsWith('skill:') || lower.startsWith('skill_') || lower.startsWith('skills_') || lower.includes('skill')) return 'Skills';
  return 'Tools';
}

function orderedToolSearchKinds(kinds) {
  const set = new Set((kinds || []).filter(Boolean));
  const order = ['Tools', 'MCP', 'Skills'];
  const out = order.filter((kind) => set.has(kind));
  return out.length ? out : ['Tools'];
}

function inferToolSearchKinds(args = {}) {
  const selected = splitToolSearchSelection(args.select);
  if (selected.length) return orderedToolSearchKinds(selected.map(toolSearchTargetKind));

  const query = firstText(args.query, args.q, args.text).toLowerCase();
  const kinds = [];
  if (/\bmcp\b|mcp__|mcp[-_\s]?server/.test(query)) kinds.push('MCP');
  if (/\bskills?\b|skill_|use[-_\s]?skill/.test(query)) kinds.push('Skills');
  return orderedToolSearchKinds(kinds);
}

export function toolSearchDisplayLabel(args = {}) {
  return `Load ${inferToolSearchKinds(args).join('/')}`;
}

export function displayToolSearchTarget(value) {
  const text = String(value || '').trim();
  if (/^skill:/i.test(text)) return text.slice('skill:'.length);
  const mcp = /^mcp__(.*?)__(.+)$/.exec(text);
  if (mcp) return `${mcp[1]}.${mcp[2]}`;
  return stripToolPrefix(text);
}

export function titleizeToolName(name) {
  return stripToolPrefix(name)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'ui') return 'UI';
      if (lower === 'mcp') return 'MCP';
      if (lower === 'id') return 'ID';
      return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join(' ') || 'Tool';
}

const AGENT_DISPLAY_NAMES = new Map([
  ['explore', 'Explore'],
  ['maintainer', 'Maintainer'],
  ['worker', 'Worker'],
  ['heavy-worker', 'Heavy Worker'],
  ['reviewer', 'Reviewer'],
  ['debugger', 'Debugger'],
]);

function titleizeDisplayName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'ui') return 'UI';
      if (lower === 'mcp') return 'MCP';
      if (lower === 'id') return 'ID';
      return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join(' ');
}

export function displayAgentName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const key = text.toLowerCase().replace(/[\s_]+/g, '-');
  return AGENT_DISPLAY_NAMES.get(key) || titleizeDisplayName(text);
}

export function displayModelName(model, provider, displayHint) {
  const text = String(model ?? '').trim();
  const modelId = text
    ? (text.includes('/') ? (text.split('/').filter(Boolean).at(-1) || text) : text)
    : '';
  const shown = sharedDisplayModelName(modelId, provider, displayHint);
  return shown || modelId;
}

export function bridgeAgentModelSummary(args) {
  const provider = firstText(args.provider, args.providerId, args.provider_id);
  const modelId = firstText(args.model);
  const displayHint = firstText(args.modelDisplay, args.model_display, args.displayModel);
  return compactParts([
    displayAgentName(firstText(args.agent, args.name, args.subagent_type)),
    displayModelName(modelId, provider, displayHint),
  ]);
}

export function summarizeLineWindow(a) {
  const offset = a.offset ?? a.start_line ?? a.startLine ?? a.line;
  const limit = a.limit ?? a.line_count ?? a.lineCount ?? a.lines;
  if (offset == null && limit == null) return '';
  const start = Number(offset);
  const count = Number(limit);
  if (Number.isFinite(start) && Number.isFinite(count) && count > 0) {
    return `lines ${start}-${Math.max(start, start + count - 1)}`;
  }
  if (Number.isFinite(start)) return `from line ${start}`;
  if (Number.isFinite(count)) return `${count} lines`;
  return '';
}

export function summarizePatch(patch, basePath) {
  const text = String(patch ?? '');
  const files = [];
  for (const line of text.split('\n')) {
    const match = /^\*\*\*\s+(?:Update|Add|Delete) File:\s+(.+)\s*$/.exec(line);
    if (match) files.push(displayToolPath(match[1]));
  }
  if (files.length === 1) return files[0];
  if (files.length > 1) return `${files.length} files`;
  if (basePath) return displayToolPath(basePath);
  return text ? 'patch' : '';
}

export function collectionCount(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const count = value.filter((item) => item != null && String(item).trim()).length;
      return count || value.length || 0;
    }
    if (value && typeof value === 'object') return 1;
    if (value != null && String(value).trim()) return 1;
  }
  return 0;
}

export function formatCountedUnit(count, singular, pluralText = `${singular}s`) {
  const n = Math.max(0, Number(count || 0));
  return n > 0 ? `${n} ${pluralize(n, singular, pluralText)}` : '';
}

export function patchFileCount(args = {}) {
  const patchText = String(args.patch ?? '');
  if (patchText) {
    const files = new Set();
    for (const line of patchText.split('\n')) {
      const match = /^\*\*\*\s+(?:Update|Add|Delete) File:\s+(.+)\s*$/.exec(line);
      if (match) files.add(match[1].trim());
    }
    if (files.size > 0) return files.size;
  }
  return collectionCount(args.path, args.file, args.file_path, args.base_path);
}

export function codeGraphLabel(args) {
  const mode = String(args.mode || args.action || '').toLowerCase();
  if (mode === 'prewarm' || mode === 'index' || mode === 'build' || mode === 'refresh') return 'Setup';
  if (mode === 'search' || mode === 'find_symbol' || mode === 'references' || mode === 'callers' || mode === 'callees') return 'Search';
  return 'Read';
}

export function codeGraphSummary(args, max) {
  return compactParts([
    args.mode || args.action || '',
    truncateToolText(firstText(args.symbol, Array.isArray(args.symbols) ? args.symbols.join(', ') : '', args.file, args.path, args.query), max),
  ]);
}

export function pluralize(count, singular, pluralText = `${singular}s`) {
  return count === 1 ? singular : pluralText;
}

export function titleWord(value) {
  const text = String(value || '');
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1).toLowerCase()}` : '';
}

export function titleStatus(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^ok$/i.test(text)) return 'Ok';
  if (/^(done|success|completed)$/i.test(text)) return 'Finished';
  if (/^(error|failed|fail|killed|timeout)$/i.test(text)) return 'Failed';
  if (/^(cancelled|canceled|cancel)$/i.test(text)) return 'Cancelled';
  return titleWord(text);
}
