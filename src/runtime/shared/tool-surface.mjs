const DEFAULT_SUMMARY_MAX = 160;
// Semantic cap for collapsed agent/task card one-liners (spawn, send, response).
export const AGENT_SURFACE_BRIEF_MAX = 120;
const STATUS_SEPARATOR = ' · ';

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

function truncateSingleLine(value, max = DEFAULT_SUMMARY_MAX) {
  return truncateToolText(String(value ?? '').replace(/\s+/g, ' '), max);
}

function truncateCommand(value, max = DEFAULT_SUMMARY_MAX) {
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

function compactParts(parts) {
  return parts.filter((part) => part != null && String(part).trim()).map((part) => String(part).trim()).join(STATUS_SEPARATOR);
}

function compactSlash(left, right) {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  return a && b ? `${a}/${b}` : a || b;
}

function mcpToolTarget(name, max = DEFAULT_SUMMARY_MAX) {
  const mcp = parseMcpToolName(name);
  if (!mcp) return '';
  return truncateToolText(compactSlash(mcp.server, mcp.tool), max);
}

function quoted(value, max) {
  const text = truncateToolText(value || '', max);
  return text ? `"${text}"` : '';
}

function firstText(...values) {
  for (const value of values) {
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function splitToolSearchSelection(value) {
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

function toolSearchDisplayLabel(args = {}) {
  return `Load ${inferToolSearchKinds(args).join('/')}`;
}

function displayToolSearchTarget(value) {
  const text = String(value || '').trim();
  if (/^skill:/i.test(text)) return text.slice('skill:'.length);
  const mcp = /^mcp__(.*?)__(.+)$/.exec(text);
  if (mcp) return `${mcp[1]}.${mcp[2]}`;
  return stripToolPrefix(text);
}

function titleizeToolName(name) {
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

function displayAgentName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const key = text.toLowerCase().replace(/[\s_]+/g, '-');
  return AGENT_DISPLAY_NAMES.get(key) || titleizeDisplayName(text);
}

export function displayModelName(model) {
  const text = String(model || '').trim();
  if (!text) return '';
  const raw = text.includes('/') ? (text.split('/').filter(Boolean).at(-1) || text) : text;
  const lower = raw.toLowerCase();
  const newClaude = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(lower);
  if (newClaude) {
    const family = titleizeDisplayName(newClaude[1]);
    const minor = newClaude[3] && newClaude[3].length <= 2 ? `.${newClaude[3]}` : '';
    return `${family} ${newClaude[2]}${minor}`;
  }
  const oldClaude = /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)(?:-|$)/i.exec(lower);
  if (oldClaude) {
    const family = titleizeDisplayName(oldClaude[3]);
    return `${family} ${oldClaude[1]}${oldClaude[2] ? `.${oldClaude[2]}` : ''}`;
  }
  if (lower.startsWith('gpt-')) {
    return raw
      .split('-')
      .map((part, index) => (index === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('-');
  }
  if (lower.startsWith('grok-')) {
    return raw
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  return raw;
}

function bridgeAgentModelSummary(args) {
  return compactParts([
    displayAgentName(firstText(args.agent, args.role, args.name, args.subagent_type)),
    displayModelName(firstText(args.modelDisplay, args.model_display, args.displayModel, args.model)),
  ]);
}

function summarizeLineWindow(a) {
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

function summarizePatch(patch, basePath) {
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

function collectionCount(...values) {
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

function formatCountedUnit(count, singular, pluralText = `${singular}s`) {
  const n = Math.max(0, Number(count || 0));
  return n > 0 ? `${n} ${pluralize(n, singular, pluralText)}` : '';
}

function patchFileCount(args = {}) {
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

function codeGraphLabel(args) {
  const mode = String(args.mode || args.action || '').toLowerCase();
  if (mode === 'prewarm' || mode === 'index' || mode === 'build' || mode === 'refresh') return 'Setup';
  if (mode === 'search' || mode === 'find_symbol' || mode === 'references' || mode === 'callers' || mode === 'callees') return 'Search';
  return 'Read';
}

function codeGraphSummary(args, max) {
  return compactParts([
    args.mode || args.action || '',
    truncateToolText(firstText(args.symbol, Array.isArray(args.symbols) ? args.symbols.join(', ') : '', args.file, args.path, args.query), max),
  ]);
}

export function displayToolName(name, args = {}) {
  if (isMcpToolName(name)) return 'MCP';
  const normalized = normalizeToolName(name);
  switch (normalized) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource':
      return 'Read';
    case 'apply_patch': {
      const parsed = parseToolArgs(args);
      if (parsed && parsed.dry_run === true) return 'Check';
      return parsed && parsed.old_string === '' ? 'Create' : 'Update';
    }
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return 'Run';
    case 'task':
      return 'Task';
    case 'grep':
    case 'find':
    case 'glob':
    case 'list':
    case 'ls':
      return 'Search';
    case 'trigger_schedule':
      return 'Schedule';
    case 'tool_search':
      return toolSearchDisplayLabel(parseToolArgs(args));
    case 'search':
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
      return 'Web Search';
    case 'explore':
      return 'Explore';
    case 'web_fetch':
    case 'fetch':
    case 'download_attachment':
      return 'Fetch';
    case 'diagnostics':
    case 'open_config':
    case 'provider_status':
    case 'channel_status':
    case 'schedule_status':
    case 'schedule_control':
    case 'reload_config':
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
    case 'cwd':
      return 'Setup';
    case 'request_user_input':
      return 'Ask User';
    case 'update_plan':
      return 'Plan';
    case 'memory':
    case 'remember':
    case 'save_memory':
    case 'update_memory':
    case 'recall_memory':
    case 'recall':
    case 'search_memories':
      return 'Memory';
    case 'skill':
    case 'skill_execute':
    case 'skill_view':
    case 'skills_list':
    case 'use_skill':
      return 'Skill';
    case 'bridge':
    case 'agent':
      return 'Agent';
    case 'code_graph':
      return codeGraphLabel(parseToolArgs(args));
    case 'reply':
    case 'react':
    case 'edit_message':
    case 'activate_channel_bridge':
    case 'inject_command':
      return 'Channel';
    default:
      return titleizeToolName(name);
  }
}

export function summarizeToolArgs(name, args, { max = DEFAULT_SUMMARY_MAX } = {}) {
  const a = parseToolArgs(args);
  if (!a || typeof a !== 'object') return '';
  const normalized = normalizeToolName(name);
  const mcpTarget = mcpToolTarget(name, max);
  if (mcpTarget) {
    return compactParts([
      mcpTarget,
      truncateToolText(firstText(a.query, a.q, a.text, a.prompt, a.path, a.uri, a.name, a.id, a.action), Math.min(max, 80)),
    ]);
  }
  switch (normalized) {
    case 'read':
      if (!a.path && !a.file_path) return '';
      if (Array.isArray(a.path) || Array.isArray(a.file_path)) {
        return formatCountedUnit(collectionCount(a.path, a.file_path), 'file');
      }
      return compactParts([
        displayToolPath(a.path ?? a.file_path),
        a.pages ? `pages ${a.pages}` : summarizeLineWindow(a),
      ]);
    case 'view_image':
      return displayToolPath(a.path || a.file_path || '');
    case 'apply_patch':
      return summarizePatch(a.patch, a.base_path);
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return truncateCommand(a.description || a.command || a.cmd || '', max);
    case 'task':
      return compactParts([a.action || a.type || 'task', a.task_id || '']);
    case 'list':
    case 'ls':
      if (Array.isArray(a.path) || Array.isArray(a.dir) || Array.isArray(a.cwd)) {
        return formatCountedUnit(collectionCount(a.path, a.dir, a.cwd), 'directory', 'directories');
      }
      return compactParts([
        displayToolPath(a.path ?? a.dir ?? a.cwd ?? ''),
        a.head_limit || a.limit ? `${a.head_limit ?? a.limit} entries` : '',
      ]);
    case 'grep':
      if (!a.pattern && !a.query) return '';
      if (Array.isArray(a.pattern) || Array.isArray(a.query)) {
        return formatCountedUnit(collectionCount(a.pattern, a.query), 'pattern');
      }
      return compactParts([
        `pattern: ${quoted(a.pattern ?? a.query, max)}`,
        a.path ? `path: ${displayToolPath(a.path)}` : '',
        a.glob ? `glob ${a.glob}` : '',
      ]);
    case 'glob':
      if (!a.pattern && !a.glob) return '';
      if (Array.isArray(a.pattern) || Array.isArray(a.glob)) {
        return formatCountedUnit(collectionCount(a.pattern, a.glob), 'glob');
      }
      return compactParts([
        `pattern: ${quoted(a.pattern ?? a.glob, max)}`,
        a.path ? `path: ${displayToolPath(a.path)}` : '',
      ]);
    case 'find':
      if (!a.query && !a.fuzzy) return '';
      if (Array.isArray(a.query) || Array.isArray(a.fuzzy)) {
        return formatCountedUnit(collectionCount(a.query, a.fuzzy), 'query', 'queries');
      }
      return compactParts([
        quoted(a.query ?? a.fuzzy, max),
        a.path ? `path: ${displayToolPath(a.path)}` : '',
      ]);
    case 'search':
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
      if (Array.isArray(a.query) || Array.isArray(a.keywords)) {
        return formatCountedUnit(collectionCount(a.query, a.keywords), 'query', 'queries');
      }
      return quoted(a.query || a.keywords || '', max);
    case 'explore':
      if (Array.isArray(a.query) || Array.isArray(a.prompt) || Array.isArray(a.task) || Array.isArray(a.goal)) {
        return formatCountedUnit(collectionCount(a.query, a.prompt, a.task, a.goal), 'query', 'queries');
      }
      return truncateSingleLine(firstText(a.query, a.prompt, a.task, a.goal, a.path), Math.min(max, 80));
    case 'tool_search':
      {
        const selected = splitToolSearchSelection(a.select);
        if (selected.length) return truncateToolText(selected.map(displayToolSearchTarget).join(', '), max);
        return quoted(firstText(a.query, a.q, a.text), max);
      }
    case 'web_fetch':
    case 'fetch':
      if (Array.isArray(a.url) || Array.isArray(a.uri)) {
        return formatCountedUnit(collectionCount(a.url, a.uri), 'URL', 'URLs');
      }
      return truncateToolText(a.url || a.uri || '', max);
    case 'download_attachment':
      return displayToolPath(a.filename || a.name || a.url || '');
    case 'read_mcp_resource':
      return truncateToolText(a.uri || '', max);
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return a.server ? `server "${truncateToolText(a.server, max)}"` : 'all servers';
    case 'diagnostics':
      return truncateToolText(a.scope || a.mode || 'runtime', max);
    case 'open_config':
      return truncateToolText(a.section || a.tab || 'config', max);
    case 'provider_status':
      return truncateToolText(a.provider || 'providers', max);
    case 'channel_status':
      return truncateToolText(a.channel || a.name || 'channels', max);
    case 'schedule_status':
    case 'schedule_control':
    case 'trigger_schedule':
      return compactParts([a.action || a.type || 'schedule', a.name || a.id || '']);
    case 'reload_config':
      return truncateToolText(a.scope || 'config', max);
    case 'cwd':
      return truncateToolText(firstText(a.path, a.cwd, a.dir), max);
    case 'memory':
    case 'remember':
    case 'save_memory':
    case 'update_memory':
    case 'recall_memory':
      return compactParts([
        a.action || a.type || a.operation || a.op || 'memory',
        truncateToolText(firstText(a.query, a.summary, a.element, a.key, a.name, a.text, a.value), Math.min(max, 80)),
      ]);
    case 'recall':
    case 'search_memories':
      return compactParts([
        quoted(firstText(a.query, a.text, a.input), max),
        a.limit || a.topK ? `top ${a.limit ?? a.topK}` : '',
      ]);
    case 'bridge':
    case 'agent': {
      const agentModel = bridgeAgentModelSummary(a);
      if (agentModel) return agentModel;
      const bridgeAction = a.type || a.action || a.mode || '';
      const showTarget = !/^(status|read)$/i.test(String(bridgeAction || ''));
      return compactParts([
        bridgeAction,
        showTarget ? (a.tag || a.sessionId || a.task_id || '') : '',
      ]);
    }
    case 'code_graph':
      return codeGraphSummary(a, max);
    case 'reply':
    case 'react':
    case 'edit_message':
      return truncateToolText(a.channel || a.channelId || a.messageId || a.emoji || '', max);
    case 'activate_channel_bridge':
      return a.active === false ? 'deactivate' : 'activate';
    case 'inject_command':
      return truncateToolText(firstText(a.command, a.text, a.name), max);
    case 'skill':
    case 'skill_execute':
    case 'skill_view':
    case 'skills_list':
    case 'use_skill':
      return truncateToolText(firstText(a.name, a.skill, a.skill_name, a.query, a.q, normalized === 'skills_list' ? 'all skills' : ''), max);
    default: {
      const primary = firstText(a.name, a.skill, a.query, a.title, a.path, a.file, a.target, a.id, a.action);
      if (primary) return truncateToolText(primary, Math.min(max, 80));
      // Last resort: compact key=value of at most the first 2 own keys.
      // Never JSON.stringify the whole object.
      const keys = Object.keys(a).slice(0, 2);
      const pairs = keys
        .map((key) => {
          const value = a[key];
          if (value == null || typeof value === 'object') return '';
          const text = truncateToolText(value, 40);
          return text ? `${key}=${text}` : '';
        })
        .filter(Boolean);
      return compactParts(pairs);
    }
  }
}

export function formatToolSurface(name, args, opts = {}) {
  const parsed = parseToolArgs(args);
  return {
    label: displayToolName(name, parsed),
    summary: summarizeToolArgs(name, parsed, opts),
    normalizedName: normalizeToolName(name),
    args: parsed,
  };
}

function pluralize(count, singular, pluralText = `${singular}s`) {
  return count === 1 ? singular : pluralText;
}

function titleWord(value) {
  const text = String(value || '');
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1).toLowerCase()}` : '';
}

function titleStatus(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^ok$/i.test(text)) return 'Ok';
  if (/^(done|success|completed)$/i.test(text)) return 'Finished';
  if (/^(error|failed|fail|killed|timeout)$/i.test(text)) return 'Failed';
  if (/^(cancelled|canceled|cancel)$/i.test(text)) return 'Cancelled';
  return titleWord(text);
}

function countNonEmptyLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim()).length;
}

function splitPathAndDelta(value, explicitDelta = '') {
  let path = String(value ?? '').trim();
  let delta = String(explicitDelta ?? '').trim();
  if (!delta) {
    const sep = path.lastIndexOf(' — ');
    if (sep !== -1) {
      delta = path.slice(sep + 3).trim();
      path = path.slice(0, sep).trim();
    }
  }
  return { path, delta };
}

function parseLineDelta(delta) {
  const totals = { added: 0, removed: 0, seen: false };
  for (const match of String(delta ?? '').matchAll(/([+-])\s*(\d+)\s*(?:line|lines)?/gi)) {
    const n = Number(match[2]) || 0;
    totals.seen = true;
    if (match[1] === '+') totals.added += n;
    else totals.removed += n;
  }
  return totals;
}

function formatLineDelta(totals) {
  if (!totals?.seen) return '';
  const added = Number(totals.added) || 0;
  const removed = Number(totals.removed) || 0;
  if (added === 0 && removed === 0) return '';
  const parts = [];
  if (added > 0) parts.push(`+${added} ${pluralize(added, 'line')}`);
  if (removed > 0) parts.push(`-${removed} ${pluralize(removed, 'line')}`);
  return parts.join(STATUS_SEPARATOR);
}

function parseUpdateSummary(text) {
  const match = /^(Updated|Created|Deleted)\s+(.+?)(?:\s+·\s+|$)/i.exec(String(text || '').trim());
  if (!match) return null;
  const action = titleWord(match[1]);
  const target = match[2].trim();
  const fileCountMatch = /^(\d+)\s+Files?$/i.exec(target);
  const totals = parseLineDelta(text);
  return {
    action,
    file: fileCountMatch ? '' : target,
    fileCount: fileCountMatch ? Number(fileCountMatch[1]) || 0 : 0,
    added: totals.added,
    removed: totals.removed,
    seen: totals.seen,
  };
}

/** Heuristic: does the text look like a line-oriented listing rather than prose? */
function looksLineOriented(text) {
  const lines = String(text ?? '').split('\n').filter((line) => line.trim());
  if (lines.length === 0) return false;
  // Prose tends to be a few long sentences; listings are many shorter rows.
  const longLines = lines.filter((line) => line.trim().length > 200).length;
  return longLines === 0;
}

function summarizeUpdateResult(text, args) {
  // A dry_run patch validates without writing, so the collapsed detail must not
  // claim a real mutation ("Updated/Created/Deleted foo.js"). Map every action
  // to "Checked" wording, matching the dry-run header (Checking/Checked).
  const isDryRun = parseToolArgs(args)?.dry_run === true;
  const changed = [];
  for (const line of String(text ?? '').split('\n')) {
    const ok = /^\s*OK\s+(modify|add|delete|create)\s+(.+?)\s*$/i.exec(line);
    if (ok) {
      const { path, delta } = splitPathAndDelta(ok[2]);
      changed.push({ action: ok[1].toLowerCase(), path, delta });
      continue;
    }
    const edited = /^\s*(Edited|Created|Updated|Wrote):\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/i.exec(line);
    if (edited) {
      const { path, delta } = splitPathAndDelta(edited[2], edited[3] || '');
      changed.push({ action: edited[1].toLowerCase(), path, delta });
    }
  }
  if (changed.length === 1) {
    const item = changed[0];
    const action = isDryRun
      ? 'Checked'
      : item.action === 'delete' ? 'Deleted' : item.action === 'add' || item.action === 'create' || item.action === 'created' ? 'Created' : 'Updated';
    return compactParts([`${action} ${displayToolPath(item.path)}`, formatLineDelta(parseLineDelta(item.delta))]);
  }
  if (changed.length > 1) {
    const totals = changed.reduce((acc, item) => {
      const delta = parseLineDelta(item.delta);
      acc.added += delta.added;
      acc.removed += delta.removed;
      acc.seen = acc.seen || delta.seen;
      return acc;
    }, { added: 0, removed: 0, seen: false });
    return compactParts([`${isDryRun ? 'Checked' : 'Updated'} ${changed.length} Files`, formatLineDelta(totals)]);
  }

  const parsedArgs = parseToolArgs(args);
  const target = parsedArgs.path ?? parsedArgs.file ?? parsedArgs.file_path ?? '';
  if (target) return `${isDryRun ? 'Checked' : 'Updated'} ${displayToolPath(target)}`;
  return null;
}

function textBetweenTag(text, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(String(text ?? ''));
  return match ? match[1].trim() : '';
}

// Strip the most common inline-markdown markers so a one-line card summary
// reads as plain prose ("**not clean**" → "not clean", "`x`" → "x"). Block
// markers (#, >, -, 1.) at line start are dropped too. Whitespace is collapsed
// by the caller's truncateSingleLine.
function stripInlineMarkdown(value) {
  return String(value ?? '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function firstAgentResultLine(text) {
  const finalAnswer = textBetweenTag(text, 'final-answer') || textBetweenTag(text, 'result');
  const raw = finalAnswer || text;
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^agent result\b/i.test(trimmed)) continue;
    if (/^<\/?(?:final-answer|task-notification|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>$/i.test(trimmed)) continue;
    if (/^(?:agent task|status|type|target|role|agent|preset|model|effort|fast|limits|session|task-id|task_id|notification|queueDepth):\s*/i.test(trimmed)) continue;
    if (/^\[[a-z-]+:\s*[^\]]*\]$/i.test(trimmed)) continue;
    return truncateSingleLine(trimmed, AGENT_SURFACE_BRIEF_MAX);
  }
  return '';
}

function summarizeGenericResult(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  if (/^(?:undefined|null)$/i.test(trimmed)) return null;

  if (/^[\[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return `${parsed.length} ${pluralize(parsed.length, 'item')}`;
      if (parsed && typeof parsed === 'object') {
        const status = firstText(parsed.status, parsed.state, parsed.result, parsed.message);
        if (status) return truncateSingleLine(titleStatus(status), 120);
        if (parsed.cwd) return truncateSingleLine(parsed.cwd, 120);
        if (typeof parsed.ok === 'boolean') return parsed.ok ? 'Ok' : 'Failed';
        for (const key of ['items', 'results', 'resources', 'templates', 'providers', 'schedules', 'channels', 'tools']) {
          if (Array.isArray(parsed[key])) return `${parsed[key].length} ${pluralize(parsed[key].length, (key.slice(0, -1) || 'item').toLowerCase())}`;
        }
      }
    } catch {
      return null;
    }
  }

  const line = firstAgentResultLine(text) || trimmed.split('\n').map((item) => item.trim()).find(Boolean) || '';
  if (!line || line === '{' || line === '[') return null;
  if (/^(ok|done|success|saved|sent|updated|reloaded|connected|enabled|disabled|active|inactive)$/i.test(line)) {
    return titleStatus(line);
  }
  return truncateSingleLine(line, 120);
}

/**
 * Derive a short semantic one-liner for a completed tool call using only the
 * tool name, parsed args, and the raw result text. Returns null when nothing
 * reliable can be derived, so the caller falls back to the raw result block.
 */
export function summarizeToolResult(name, args, resultText, isError = false) {
  if (isError) return null;
  const text = String(resultText ?? '');
  const trimmed = text.trim();
  if (/^(?:undefined|null)$/i.test(trimmed)) return null;
  if (isMcpToolName(name)) return trimmed ? firstAgentResultLine(text) || null : null;
  const normalized = normalizeToolName(name);

  switch (normalized) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource': {
      if (/^\[image:/i.test(trimmed)) return 'Image';
      if (!trimmed) return null;
      const n = text.split('\n').length;
      return `${n} ${pluralize(n, 'line')}`;
    }
    case 'apply_patch': {
      const updateSummary = summarizeUpdateResult(text, args);
      if (updateSummary) return updateSummary;
      // Prefer explicit additions/removals hints if the result text states them.
      const add = /(\d+)\s+addition/i.exec(text);
      const rem = /(\d+)\s+removal/i.exec(text);
      if (add || rem) {
        const a = add ? Number(add[1]) : 0;
        const r = rem ? Number(rem[1]) : 0;
        return `+${a} -${r}`;
      }
      // Else count unified-diff style +/- lines (ignore +++/--- file headers).
      let a = 0;
      let r = 0;
      for (const line of text.split('\n')) {
        if (/^\+\+\+|^---/.test(line)) continue;
        if (/^\+/.test(line)) a += 1;
        else if (/^-/.test(line)) r += 1;
      }
      if (a > 0 || r > 0) return `+${a} -${r}`;
      return null;
    }
    case 'grep': {
      if (!trimmed || !looksLineOriented(text)) return null;
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `${n} ${pluralize(n, 'match', 'matches')}`;
    }
    case 'glob': {
      if (!trimmed || !looksLineOriented(text)) return null;
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `${n} ${pluralize(n, 'file')}`;
    }
    case 'find': {
      if (!trimmed || !looksLineOriented(text)) return null;
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `${n} ${pluralize(n, 'candidate')}`;
    }
    case 'list':
    case 'ls': {
      if (!trimmed || !looksLineOriented(text)) return null;
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `${n} ${pluralize(n, 'entry', 'entries')}`;
    }
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait': {
      if (!trimmed) return '(No Output)';
      const job = /^\[(?:task_id|job):\s*([^\]]+)\]/mi.exec(text);
      const status = /^\[status:\s*([^\]]+)\]/mi.exec(text);
      const exit = /^\[exit:\s*([^\]]+)\]/mi.exec(text);
      if (job || status || exit) {
        return compactParts([
          job ? job[1] : '',
          status ? titleStatus(status[1]) : '',
          exit ? `Exit ${exit[1]}` : '',
        ]);
      }
      const firstLine = trimmed.split('\n').map((line) => line.trim()).find(Boolean) || trimmed;
      return truncateSingleLine(firstLine, 120);
    }
    case 'code_graph': {
      const match = /(\d+)\s+(references|definitions|symbols|callers|callees|results|matches)/i.exec(text);
      if (match) return `${match[1]} ${String(match[2]).toLowerCase()}`;
      return null;
    }
    case 'web_fetch':
    case 'fetch': {
      // Status: require a status-like context (HTTP NNN, "Status: NNN",
      // or "NNN OK"/"NNN Not Found") rather than any bare 3-digit number.
      const status = /(?:HTTP[\s/]*\d?\.?\d?\s*|status[:\s]+)([1-5]\d{2})\b/i.exec(text)
        || /\b([1-5]\d{2})\s+(?:OK|Not\s+Found|Forbidden|Moved|Found|Created|No\s+Content|Bad\s+Request|Unauthorized|Internal)/.exec(text);
      const size = /\b(\d+(?:\.\d+)?\s?(?:[KMGT]?B|bytes))\b/i.exec(text);
      if (size && status) return `${size[1]} · HTTP ${status[1]}`;
      if (size) return size[1];
      if (status) return `HTTP ${status[1]}`;
      return null;
    }
    case 'download_attachment':
      return summarizeGenericResult(text);
    case 'search': {
      const match = /(\d+)\s+results?/i.exec(text);
      if (match) {
        const n = Number(match[1]);
        return `${n} ${pluralize(n, 'result')}`;
      }
      return null;
    }
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call': {
      const match = /(\d+)\s+results?/i.exec(text);
      if (match) {
        const n = Number(match[1]);
        return `${n} ${pluralize(n, 'result')}`;
      }
      return trimmed ? firstAgentResultLine(text) || null : null;
    }
    case 'explore': {
      return trimmed ? firstAgentResultLine(text) || null : null;
    }
    case 'recall':
    case 'search_memories':
    case 'memory':
    case 'remember':
    case 'save_memory':
    case 'update_memory':
    case 'reply':
    case 'react':
    case 'edit_message':
    case 'activate_channel_bridge':
    case 'inject_command':
    case 'request_user_input':
    case 'update_plan':
    case 'diagnostics':
    case 'open_config':
    case 'provider_status':
    case 'channel_status':
    case 'schedule_status':
    case 'schedule_control':
    case 'trigger_schedule':
    case 'reload_config':
    case 'cwd':
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return summarizeGenericResult(text);
    case 'skill':
    case 'skill_execute':
    case 'skill_view':
    case 'skills_list':
    case 'use_skill': {
      const parsedArgs = parseToolArgs(args);
      const target = firstText(parsedArgs.name, parsedArgs.skill, parsedArgs.skill_name);
      if (normalized === 'skills_list') {
        const count = /(\d+)\s+skills?/i.exec(text);
        if (count) return `${Number(count[1]) || count[1]} ${pluralize(Number(count[1]) || 0, 'skill')}`;
        const lines = countNonEmptyLines(text);
        return lines > 0 ? `${lines} ${pluralize(lines, 'skill')}` : null;
      }
      if (target) {
        const verb = normalized === 'skill' || normalized === 'skill_view' ? 'Loaded' : 'Used';
        return `${verb} ${truncateToolText(target, 80)}`;
      }
      return trimmed ? firstAgentResultLine(text) || null : null;
    }
    case 'agent':
    case 'task': {
      // Status-check (list/status) envelopes start with "agents: N" / "tasks: M"
      // (or "(no agents or tasks)"). Collapse them to a tight count summary
      // instead of leaking the raw "agents: 3 …" worker dump into the card.
      if (/^\(no agents or tasks\)$/im.test(text)) return 'No agents or tasks';
      const agentsCount = /^agents:\s*(\d+)/im.exec(text);
      const tasksCount = /^tasks:\s*(\d+)/im.exec(text);
      if (agentsCount || tasksCount) {
        const a = agentsCount ? Number(agentsCount[1]) : 0;
        const t = tasksCount ? Number(tasksCount[1]) : 0;
        const parts = [];
        if (agentsCount) parts.push(`${a} ${pluralize(a, 'agent')}`);
        if (tasksCount && t > 0) parts.push(`${t} ${pluralize(t, 'task')}`);
        return compactParts(parts) || 'No agents or tasks';
      }
      const answerLine = firstAgentResultLine(text);
      // Agent/task result cards show only a one-liner; full report via ctrl+o.
      if (answerLine) return truncateSingleLine(stripInlineMarkdown(answerLine), AGENT_SURFACE_BRIEF_MAX);
      const task = /^agent task:\s*(\S+)/mi.exec(text);
      const status = /^status:\s*([^\s(]+)/mi.exec(text);
      const role = /^role:\s*(.+)$/mi.exec(text);
      const preset = /^preset:\s*(.+)$/mi.exec(text);
      const model = /^model:\s*(.+)$/mi.exec(text);
      const limits = /^limits:\s*(.+)$/mi.exec(text);
      const agentModel = compactParts([
        displayAgentName(role ? role[1] : ''),
        displayModelName(model ? model[1] : ''),
      ]);
      if (agentModel) return agentModel;
      const parts = [
        task ? task[1] : '',
        role ? role[1] : '',
        preset ? preset[1] : '',
        model ? model[1] : '',
        status ? titleStatus(status[1]) : '',
        limits ? limits[1] : '',
      ].filter(Boolean);
      if (parts.length) return compactParts(parts);
      if (task) return status ? `${task[1]} ${titleStatus(status[1])}` : task[1];
      return null;
    }
    default:
      return null;
  }
}

export function isExplorerSurface(label) {
  return label === 'Read' || label === 'Search';
}

function truncateAgentSurfaceBrief(value, max = AGENT_SURFACE_BRIEF_MAX) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}\u2026`;
}

// Tight one-liner for an agent/task card: prefer the inbound prompt/message for
// spawn/send, or a stripped first line of the result when a response landed.
export function summarizeAgentSurfaceBrief(name, args, resultText, { isError = false, isResponse = false } = {}) {
  const a = parseToolArgs(args);
  const action = String(a?.type || a?.action || '').toLowerCase();
  const text = String(resultText ?? '').trim();
  if (isResponse && text) {
    const fromResult = summarizeToolResult(name, args, text, isError);
    if (fromResult) return truncateAgentSurfaceBrief(stripInlineMarkdown(fromResult));
    const line = firstAgentResultLine(text);
    if (line) return truncateAgentSurfaceBrief(stripInlineMarkdown(line));
  }
  const outbound = firstText(a?.prompt, a?.message);
  if (outbound && (action === 'spawn' || action === 'send' || !action)) {
    return truncateAgentSurfaceBrief(outbound);
  }
  if ((action === 'spawn' || action === 'send') && text && !isResponse) {
    const fromResult = summarizeToolResult(name, args, text, isError);
    if (fromResult) return truncateAgentSurfaceBrief(stripInlineMarkdown(fromResult));
  }
  return '';
}

export function isMemorySurface(label) {
  return label === 'Memory';
}

// ── Aggregate tool-card classification & formatting ──────────────

export const CATEGORY_ORDER = [
  'Read', 'Search', 'Load', 'MCP', 'Skill', 'Web Research', 'Memory', 'Explore',
  'Patch', 'Shell', 'Agent', 'Task', 'Schedule', 'Channel', 'Setup', 'Other',
];

const TOOL_CATEGORY = new Map([
  ['read', 'Read'],
  ['view_image', 'Read'],
  ['read_mcp_resource', 'Read'],
  ['grep', 'Search'],
  ['find', 'Search'],
  ['glob', 'Search'],
  ['list', 'Search'],
  ['ls', 'Search'],
  ['tool_search', 'Load'],
  ['search', 'Web Research'],
  ['web_search', 'Web Research'],
  ['search_query', 'Web Research'],
  ['image_query', 'Web Research'],
  ['web_search_call', 'Web Research'],
  ['web_fetch', 'Web Research'],
  ['fetch', 'Web Research'],
  ['download_attachment', 'Web Research'],
  ['recall', 'Memory'],
  ['recall_memory', 'Memory'],
  ['search_memories', 'Memory'],
  ['remember', 'Memory'],
  ['save_memory', 'Memory'],
  ['update_memory', 'Memory'],
  ['memory', 'Memory'],
  ['explore', 'Explore'],
  ['apply_patch', 'Patch'],
  ['bash', 'Shell'],
  ['shell', 'Shell'],
  ['shell_command', 'Shell'],
  ['bash_session', 'Shell'],
  ['job_wait', 'Shell'],
  ['task', 'Task'],
  ['agent', 'Agent'],
  ['reply', 'Channel'],
  ['react', 'Channel'],
  ['edit_message', 'Channel'],
  ['activate_channel_bridge', 'Channel'],
  ['inject_command', 'Channel'],
  ['diagnostics', 'Setup'],
  ['open_config', 'Setup'],
  ['provider_status', 'Setup'],
  ['channel_status', 'Setup'],
  ['schedule_status', 'Setup'],
  ['schedule_control', 'Setup'],
  ['reload_config', 'Setup'],
  ['list_mcp_resources', 'Setup'],
  ['list_mcp_resource_templates', 'Setup'],
  ['cwd', 'Setup'],
  ['request_user_input', 'Setup'],
  ['update_plan', 'Setup'],
  ['trigger_schedule', 'Schedule'],
  ['skill', 'Skill'],
  ['skill_execute', 'Skill'],
  ['skill_view', 'Skill'],
  ['skills_list', 'Skill'],
  ['use_skill', 'Skill'],
]);

/** Return the aggregate category for a tool name + args. */
export function classifyToolCategory(name, args = {}) {
  if (isMcpToolName(name)) return 'MCP';
  const normalized = normalizeToolName(name);
  if (normalized === 'code_graph') {
    const mode = String(args.mode || args.action || '').toLowerCase();
    if (mode === 'prewarm' || mode === 'index' || mode === 'build' || mode === 'refresh') return 'Setup';
    return (mode === 'search' || mode === 'find_symbol' || mode === 'references' || mode === 'callers' || mode === 'callees') ? 'Search' : 'Read';
  }
  return TOOL_CATEGORY.get(normalized) || 'Other';
}

const CATEGORY_COPY = new Map([
  ['Read', { active: 'Reading', done: 'Read', noun: 'file' }],
  ['Search', { active: 'Searching', done: 'Searched', noun: 'file' }],
  ['Load', { active: 'Loading', done: 'Loaded', noun: 'tool' }],
  ['MCP', { active: 'Using', done: 'Used', noun: 'MCP tool' }],
  ['Skill', { active: 'Loading', done: 'Loaded', noun: 'skill' }],
  ['Web Research', { active: 'Researching', done: 'Researched', noun: 'query', pluralNoun: 'queries' }],
  ['Memory', { active: 'Checking', done: 'Checked', noun: 'memory item' }],
  ['Explore', { active: 'Exploring', done: 'Explored', noun: 'query', pluralNoun: 'queries' }],
  ['Patch', { active: 'Editing', done: 'Edited', noun: 'file' }],
  ['Shell', { active: 'Running', done: 'Ran', noun: 'command' }],
  ['Agent', { active: 'Calling', done: 'Called', noun: 'agent' }],
  ['Task', { active: 'Checking', done: 'Checked', noun: 'task' }],
  ['Schedule', { active: 'Running', done: 'Ran', noun: 'schedule' }],
  ['Channel', { active: 'Sending', done: 'Sent', noun: 'message' }],
  ['Setup', { active: 'Setting up', done: 'Set up', noun: 'item' }],
  ['Other', { active: 'Calling', done: 'Called', noun: 'tool' }],
]);

/** Active gerund for a category (e.g. "Reading" for "Read"). */
export function activeCategoryLabel(category) {
  return CATEGORY_COPY.get(category)?.active || category;
}

function doneCategoryLabel(category) {
  return CATEGORY_COPY.get(category)?.done || category;
}

function categoryNoun(category, count) {
  const copy = CATEGORY_COPY.get(category) || { noun: 'item' };
  return pluralize(count, copy.noun, copy.pluralNoun || `${copy.noun}s`);
}

function categoryCopy(category) {
  return CATEGORY_COPY.get(category) || CATEGORY_COPY.get('Other') || { active: 'Calling', done: 'Called', noun: 'tool' };
}

function unitDescriptor(category, overrides = {}) {
  const copy = categoryCopy(category);
  return {
    category,
    active: overrides.active || copy.active,
    done: overrides.done || copy.done,
    noun: overrides.noun || copy.noun || 'item',
    pluralNoun: overrides.pluralNoun || copy.pluralNoun || `${overrides.noun || copy.noun || 'item'}s`,
    count: Math.max(1, Number(overrides.count || 1)),
  };
}

function queryCount(args, ...keys) {
  return collectionCount(...keys.map((key) => args?.[key]));
}

export function toolWorkUnit(name, args = {}, category = '') {
  const a = parseToolArgs(args);
  const normalized = normalizeToolName(name);
  const cat = category || classifyToolCategory(name, a);
  if (isMcpToolName(name)) {
    return unitDescriptor('MCP', { count: queryCount(a, 'query', 'q', 'text', 'prompt', 'path', 'uri', 'name', 'id', 'action') || 1 });
  }
  switch (normalized) {
    case 'read':
      return unitDescriptor('Read', { count: queryCount(a, 'path', 'paths', 'file_path', 'file', 'files') || 1, noun: 'file' });
    case 'view_image':
      return unitDescriptor('Read', { count: queryCount(a, 'path', 'file_path', 'file') || 1, noun: 'image' });
    case 'read_mcp_resource':
      return unitDescriptor('Read', { count: queryCount(a, 'uri', 'uris') || 1, noun: 'resource' });
    case 'apply_patch': {
      const creating = a.old_string === '';
      // A dry_run patch validates the diff WITHOUT writing any file, so the
      // header must not claim "Editing/Edited" (which made a pure validation
      // look like a real edit). Surface it as "Checking/Checked" instead.
      if (a.dry_run === true) {
        return unitDescriptor('Patch', {
          count: patchFileCount(a) || 1,
          active: 'Checking',
          done: 'Checked',
          noun: 'file',
        });
      }
      return unitDescriptor('Patch', {
        count: patchFileCount(a) || 1,
        active: creating ? 'Creating' : 'Editing',
        done: creating ? 'Created' : 'Edited',
        noun: 'file',
      });
    }
    case 'grep':
      return unitDescriptor('Search', { count: queryCount(a, 'pattern', 'patterns', 'query') || 1, active: 'Searching', done: 'Searched', noun: 'pattern' });
    case 'glob':
      return unitDescriptor('Search', { count: queryCount(a, 'pattern', 'patterns', 'glob', 'globs') || 1, active: 'Finding', done: 'Found', noun: 'glob' });
    case 'find':
      return unitDescriptor('Search', { count: queryCount(a, 'query', 'queries', 'fuzzy') || 1, active: 'Finding', done: 'Found', noun: 'query', pluralNoun: 'queries' });
    case 'list':
    case 'ls':
      return unitDescriptor('Search', { count: queryCount(a, 'path', 'paths', 'dir', 'dirs', 'cwd') || 1, active: 'Listing', done: 'Listed', noun: 'directory', pluralNoun: 'directories' });
    case 'tool_search': {
      const selected = splitToolSearchSelection(a.select);
      if (selected.length) return unitDescriptor('Load', { count: selected.length, noun: 'tool' });
      return unitDescriptor('Load', { count: queryCount(a, 'query', 'q', 'text') || 1, noun: 'query', pluralNoun: 'queries' });
    }
    case 'search':
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
      return unitDescriptor('Web Research', { count: queryCount(a, 'query', 'queries', 'keywords') || 1, noun: 'query', pluralNoun: 'queries' });
    case 'web_fetch':
    case 'fetch':
      return unitDescriptor('Web Research', { count: queryCount(a, 'url', 'urls', 'uri', 'uris') || 1, active: 'Fetching', done: 'Fetched', noun: 'URL', pluralNoun: 'URLs' });
    case 'download_attachment':
      return unitDescriptor('Web Research', { count: queryCount(a, 'url', 'urls', 'filename', 'name') || 1, active: 'Downloading', done: 'Downloaded', noun: 'attachment' });
    case 'recall':
    case 'recall_memory':
    case 'search_memories':
      return unitDescriptor('Memory', { count: queryCount(a, 'query', 'queries', 'text', 'input') || 1, noun: 'memory item', pluralNoun: 'memory items' });
    case 'remember':
    case 'save_memory':
    case 'update_memory':
    case 'memory':
      return unitDescriptor('Memory', { count: queryCount(a, 'entries', 'items', 'memories', 'query', 'text', 'value') || 1, active: 'Writing', done: 'Wrote', noun: 'memory item' });
    case 'explore':
      return unitDescriptor('Explore', { count: queryCount(a, 'query', 'queries', 'prompt', 'task', 'goal') || 1, noun: 'query', pluralNoun: 'queries' });
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return unitDescriptor('Shell', { count: queryCount(a, 'command', 'commands', 'cmd') || 1, noun: 'command' });
    case 'agent':
    case 'bridge':
      return unitDescriptor('Agent', { count: queryCount(a, 'agents', 'roles', 'role', 'tag', 'task_id', 'sessionId') || 1, noun: 'agent' });
    case 'task':
      return unitDescriptor('Task', { count: queryCount(a, 'task_id', 'task_ids', 'id', 'ids') || 1, noun: 'task' });
    case 'skill':
    case 'skill_execute':
    case 'skill_view':
    case 'skills_list':
    case 'use_skill':
      return unitDescriptor('Skill', { count: queryCount(a, 'name', 'skill', 'skill_name', 'query', 'q') || 1, noun: 'skill' });
    case 'reply':
      return unitDescriptor('Channel', { count: queryCount(a, 'messages', 'messageId', 'text') || 1, noun: 'message' });
    case 'react':
      return unitDescriptor('Channel', { count: queryCount(a, 'emoji', 'messageId') || 1, active: 'Reacting', done: 'Reacted', noun: 'reaction' });
    case 'edit_message':
      return unitDescriptor('Channel', { count: queryCount(a, 'messageId', 'text') || 1, active: 'Editing', done: 'Edited', noun: 'message' });
    case 'activate_channel_bridge':
      return unitDescriptor('Channel', { active: 'Toggling', done: 'Toggled', noun: 'channel bridge' });
    case 'inject_command':
      return unitDescriptor('Channel', { count: queryCount(a, 'command', 'text', 'name') || 1, active: 'Injecting', done: 'Injected', noun: 'command' });
    case 'trigger_schedule':
      return unitDescriptor('Schedule', { count: queryCount(a, 'name', 'id') || 1, noun: 'schedule' });
    case 'code_graph': {
      const mode = String(a.mode || a.action || '').toLowerCase();
      const searching = mode === 'search' || mode === 'find_symbol' || mode === 'references' || mode === 'callers' || mode === 'callees';
      return unitDescriptor(searching ? 'Search' : 'Read', {
        count: queryCount(a, 'symbols', 'symbol', 'query', 'file', 'path') || 1,
        active: searching ? 'Mapping' : 'Reading',
        done: searching ? 'Mapped' : 'Read',
        noun: searching ? 'symbol' : 'file',
      });
    }
    case 'request_user_input':
      return unitDescriptor('Setup', { active: 'Asking', done: 'Asked', noun: 'user' });
    case 'update_plan':
      return unitDescriptor('Setup', { active: 'Updating', done: 'Updated', noun: 'plan' });
    case 'diagnostics':
      return unitDescriptor('Setup', { active: 'Checking', done: 'Checked', noun: 'diagnostic' });
    case 'open_config':
      return unitDescriptor('Setup', { active: 'Opening', done: 'Opened', noun: 'config' });
    case 'provider_status':
      return unitDescriptor('Setup', { active: 'Checking', done: 'Checked', noun: 'provider' });
    case 'channel_status':
      return unitDescriptor('Setup', { active: 'Checking', done: 'Checked', noun: 'channel' });
    case 'schedule_status':
      return unitDescriptor('Setup', { active: 'Checking', done: 'Checked', noun: 'schedule' });
    case 'schedule_control':
      return unitDescriptor('Setup', { active: 'Updating', done: 'Updated', noun: 'schedule' });
    case 'reload_config':
      return unitDescriptor('Setup', { active: 'Reloading', done: 'Reloaded', noun: 'config' });
    case 'list_mcp_resources':
      return unitDescriptor('Setup', { active: 'Listing', done: 'Listed', noun: 'MCP resource' });
    case 'list_mcp_resource_templates':
      return unitDescriptor('Setup', { active: 'Listing', done: 'Listed', noun: 'MCP resource template' });
    case 'cwd': {
      const action = String(a.action || a.type || '').toLowerCase();
      return action === 'set'
        ? unitDescriptor('Setup', { active: 'Setting', done: 'Set', noun: 'working directory', pluralNoun: 'working directories' })
        : unitDescriptor('Setup', { active: 'Checking', done: 'Checked', noun: 'working directory', pluralNoun: 'working directories' });
    }
    default:
      return unitDescriptor(cat, { count: queryCount(a, 'items', 'targets', 'query', 'path', 'name', 'id', 'action') || 1 });
  }
}

function lifecycleVerb(unit, pending, { stableVerbWidth = false } = {}) {
  const active = String(unit.active || '');
  const done = String(unit.done || '');
  const verb = pending ? active : done;
  if (!stableVerbWidth) return verb;
  return verb.padEnd(Math.max(active.length, done.length), ' ');
}

export function formatToolActionHeader(name, args = {}, { pending = false, count = 1, category = '', stableVerbWidth = false } = {}) {
  const unit = toolWorkUnit(name, args, category);
  const n = Math.max(1, Number(unit.count || count || 1));
  const verb = lifecycleVerb(unit, pending, { stableVerbWidth });
  return `${verb} ${n} ${pluralize(n, unit.noun, unit.pluralNoun)}`;
}

export function aggregateToolCategoryEntry(name, args = {}, category = '') {
  const cat = category || classifyToolCategory(name, args);
  const unit = toolWorkUnit(name, args, cat);
  const key = [cat, unit.active, unit.done, unit.noun, unit.pluralNoun].join('|');
  return {
    key,
    category: cat,
    active: unit.active,
    done: unit.done,
    noun: unit.noun,
    pluralNoun: unit.pluralNoun,
    count: Math.max(1, Number(unit.count || 1)),
  };
}

function aggregateCount(value) {
  if (value && typeof value === 'object') return Math.max(0, Number(value.count || 0));
  return Math.max(0, Number(value || 0));
}

function aggregateDescriptor(key, value) {
  if (value && typeof value === 'object') {
    const category = value.category || String(key || '').split('|')[0] || 'Other';
    const copy = categoryCopy(category);
    const noun = value.noun || copy.noun || 'item';
    return {
      category,
      active: value.active || copy.active,
      done: value.done || copy.done,
      noun,
      pluralNoun: value.pluralNoun || copy.pluralNoun || `${noun}s`,
      count: aggregateCount(value),
    };
  }
  const category = String(key || '');
  const copy = categoryCopy(category);
  const noun = copy.noun || 'item';
  return {
    category,
    active: copy.active,
    done: copy.done,
    noun,
    pluralNoun: copy.pluralNoun || `${noun}s`,
    count: aggregateCount(value),
  };
}

/**
 * Build a comma-separated header from per-category counts.
 * e.g. "Read 6 items, Searched 5 items, Called 1 agent"
 */
export function formatAggregateHeader(categories, { pending = false, order = null, stableVerbWidth = false } = {}) {
  const categoryKeys = Object.keys(categories || {});
  const preferred = Array.isArray(order) && order.length ? order : categoryKeys;
  const seen = new Set();
  const ordered = [];
  const add = (cat) => {
    if (!cat || seen.has(cat) || aggregateCount(categories[cat]) <= 0) return;
    seen.add(cat);
    ordered.push(cat);
  };
  for (const cat of preferred) add(cat);
  for (const cat of CATEGORY_ORDER) add(cat);
  for (const cat of Object.keys(categories || {})) add(cat);

  return ordered
    .map((cat) => {
      const item = aggregateDescriptor(cat, categories[cat]);
      const label = lifecycleVerb(item, pending, { stableVerbWidth });
      return `${label} ${item.count} ${pluralize(item.count, item.noun, item.pluralNoun)}`;
    })
    .join(', ');
}

/**
 * Join a list of per-call result summaries into a single detail line,
 * deduplicating exact repeats while preserving order.
 */
export function formatAggregateDetail(summaries) {
  if (!summaries || summaries.length === 0) return '';
  const metrics = new Map();
  const order = [];
  const extras = new Set();

  const addMetric = (key, initial) => {
    if (!metrics.has(key)) {
      metrics.set(key, { ...initial });
      order.push({ type: 'metric', key });
      return metrics.get(key);
    }
    return metrics.get(key);
  };

  const addExtra = (text) => {
    if (!text || extras.has(text)) return;
    extras.add(text);
    order.push({ type: 'extra', text });
  };

  for (const raw of summaries) {
    const text = String(raw || '').trim();
    if (!text) continue;

    let match = /^(?:Read\s+)?(\d+)\s+lines?$/i.exec(text);
    if (match) {
      const metric = addMetric('read_lines', { count: 0, render: (m) => `${m.count} ${pluralize(m.count, 'line')}` });
      metric.count += Number(match[1]);
      continue;
    }

    if (/^(?:Read\s+)?image$/i.test(text)) {
      const metric = addMetric('read_images', { count: 0, render: (m) => `${m.count} ${pluralize(m.count, 'image')}` });
      metric.count += 1;
      continue;
    }

    match = /^(?:Found\s+)?(\d+)\s+([a-z]+)$/i.exec(text);
    if (match) {
      const nounRaw = match[2].toLowerCase();
      const singular = nounRaw.endsWith('ies') ? `${nounRaw.slice(0, -3)}y` : nounRaw.endsWith('s') ? nounRaw.slice(0, -1) : nounRaw;
      const plural = nounRaw.endsWith('s') ? nounRaw : `${nounRaw}s`;
      const key = `found_${plural}`;
      const metric = addMetric(key, { count: 0, singular, plural, render: (m) => `${m.count} ${pluralize(m.count, m.singular, m.plural)}` });
      metric.count += Number(match[1]);
      continue;
    }

    match = /^(?:Updated(?:\s+-)?\s+)?\+(\d+)\s+-(\d+)$/i.exec(text);
    if (match) {
      const metric = addMetric('updated', { added: 0, removed: 0, render: (m) => `+${m.added} -${m.removed}` });
      metric.added += Number(match[1]);
      metric.removed += Number(match[2]);
      continue;
    }

    const update = parseUpdateSummary(text);
    if (update) {
      const metric = addMetric('updated_files', {
        files: new Set(),
        fileCount: 0,
        actions: new Set(),
        added: 0,
        removed: 0,
        seen: false,
        render: (m) => {
          // The aggregate header already carries the action + file count
          // (e.g. "Edited 2 files"), so the detail row shows only the merged
          // line delta. Fall back to the action + file/count summary only when
          // there is no +/- delta to show (e.g. pure create/delete).
          const delta = formatLineDelta(m);
          if (delta) return delta;
          const count = m.fileCount + m.files.size;
          const action = m.actions.size === 1 ? [...m.actions][0] : 'Updated';
          const target = count === 1 && m.fileCount === 0 ? [...m.files][0] : `${count} ${pluralize(count, 'file')}`;
          return `${action} ${target}`;
        },
      });
      if (update.file) metric.files.add(update.file);
      metric.fileCount += update.fileCount;
      metric.actions.add(update.action);
      metric.added += update.added;
      metric.removed += update.removed;
      metric.seen = metric.seen || update.seen;
      continue;
    }

    addExtra(text);
  }

  return order
    .map((item) => item.type === 'metric' ? metrics.get(item.key)?.render(metrics.get(item.key)) : item.text)
    .filter(Boolean)
    .join(', ');
}
