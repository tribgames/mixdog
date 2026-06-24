const DEFAULT_SUMMARY_MAX = 160;

export function stripToolPrefix(name) {
  return String(name || 'tool')
    .replace(/^mcp__.*__/, '')
    .replace(/^functions\./, '');
}

export function normalizeToolName(name) {
  return stripToolPrefix(name).replace(/-/g, '_').toLowerCase();
}

export function truncateToolText(value, max = DEFAULT_SUMMARY_MAX) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
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
  return parts.filter((part) => part != null && String(part).trim()).map((part) => String(part).trim()).join(' · ');
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

function codeGraphLabel(args) {
  const mode = String(args.mode || args.action || '').toLowerCase();
  if (mode === 'prewarm' || mode === 'index' || mode === 'build' || mode === 'refresh') return 'Setup';
  if (mode === 'search' || mode === 'find_symbol') return 'Search';
  return 'Read';
}

function codeGraphSummary(args, max) {
  return compactParts([
    args.mode || args.action || '',
    truncateToolText(firstText(args.symbol, Array.isArray(args.symbols) ? args.symbols.join(', ') : '', args.file, args.path, args.query), max),
  ]);
}

export function displayToolName(name, args = {}) {
  const normalized = normalizeToolName(name);
  switch (normalized) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource':
      return 'Read';
    case 'write':
    case 'edit':
    case 'apply_patch':
      return 'Update';
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
    case 'trigger_schedule':
      return 'Run';
    case 'grep':
    case 'glob':
    case 'tool_search':
      return 'Search';
    case 'search':
      return 'Web Search';
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
    case 'bridge':
    case 'agent':
    case 'task':
      return 'Agent';
    case 'code_graph':
      return codeGraphLabel(parseToolArgs(args));
    case 'reply':
    case 'react':
    case 'edit_message':
      return 'Channel';
    default:
      return titleizeToolName(name);
  }
}

export function summarizeToolArgs(name, args, { max = DEFAULT_SUMMARY_MAX } = {}) {
  const a = parseToolArgs(args);
  if (!a || typeof a !== 'object') return '';
  switch (normalizeToolName(name)) {
    case 'read':
      if (!a.path && !a.file_path) return '';
      return compactParts([
        displayToolPath(a.path ?? a.file_path),
        a.pages ? `pages ${a.pages}` : summarizeLineWindow(a),
      ]);
    case 'view_image':
      return displayToolPath(a.path || a.file_path || '');
    case 'write':
    case 'edit':
      return displayToolPath(a.path ?? a.file ?? a.file_path ?? '');
    case 'apply_patch':
      return summarizePatch(a.patch, a.base_path);
    case 'bash':
    case 'bash_session':
    case 'shell_command':
      return truncateToolText(a.description || a.command || a.cmd || '', max);
    case 'job_wait':
      return compactParts([a.action || a.type || 'job', a.jobId || a.id || '']);
    case 'list':
    case 'ls':
      return compactParts([
        displayToolPath(a.path ?? a.dir ?? a.cwd ?? ''),
        a.head_limit || a.limit ? `${a.head_limit ?? a.limit} entries` : '',
      ]);
    case 'grep':
      if (!a.pattern && !a.query) return '';
      return compactParts([
        quoted(a.pattern ?? a.query, max),
        a.path ? `in ${displayToolPath(a.path)}` : '',
        a.glob ? `glob ${a.glob}` : '',
      ]);
    case 'glob':
      if (!a.pattern && !a.glob) return '';
      return compactParts([
        quoted(a.pattern ?? a.glob, max),
        a.path ? `in ${displayToolPath(a.path)}` : '',
      ]);
    case 'search':
      return quoted(a.query || '', max);
    case 'tool_search':
      return quoted(firstText(a.query, a.q, a.text), max);
    case 'web_fetch':
    case 'fetch':
      return truncateToolText(a.url || a.uri || '', max);
    case 'download_attachment':
      return displayToolPath(a.filename || a.name || a.url || '');
    case 'read_mcp_resource':
      return truncateToolText(a.uri || '', max);
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return truncateToolText(a.server || 'all', max);
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
    case 'agent':
    case 'task':
      return compactParts([
        a.type || a.action || a.mode || '',
        a.role || a.name || a.subagent_type || a.tag || a.sessionId || a.jobId || '',
        truncateToolText(firstText(a.description, a.prompt, a.message), Math.min(max, 80)),
      ]);
    case 'code_graph':
      return codeGraphSummary(a, max);
    case 'reply':
    case 'react':
    case 'edit_message':
      return truncateToolText(a.channel || a.channelId || a.messageId || a.emoji || '', max);
    default: {
      try {
        const s = JSON.stringify(a);
        return truncateToolText(s, Math.min(max, 80));
      } catch {
        return '';
      }
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

export function isExplorerSurface(label) {
  return label === 'Read' || label === 'Search';
}

export function isMemorySurface(label) {
  return label === 'Memory';
}
