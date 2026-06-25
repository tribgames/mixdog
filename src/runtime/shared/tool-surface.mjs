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
  return parts.filter((part) => part != null && String(part).trim()).map((part) => String(part).trim()).join(' - ');
}

function compactSlash(left, right) {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  return a && b ? `${a}/${b}` : a || b;
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
      return 'Write';
    case 'edit':
    case 'apply_patch': {
      const parsed = parseToolArgs(args);
      return parsed && parsed.old_string === '' ? 'Create' : 'Update';
    }
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
    case 'crawl':
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
    case 'setup':
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
    case 'task':
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
      return truncateCommand(a.description || a.command || a.cmd || '', max);
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
        `pattern: ${quoted(a.pattern ?? a.query, max)}`,
        a.path ? `path: ${displayToolPath(a.path)}` : '',
        a.glob ? `glob ${a.glob}` : '',
      ]);
    case 'glob':
      if (!a.pattern && !a.glob) return '';
      return compactParts([
        `pattern: ${quoted(a.pattern ?? a.glob, max)}`,
        a.path ? `path: ${displayToolPath(a.path)}` : '',
      ]);
    case 'search':
      return quoted(a.query || '', max);
    case 'tool_search':
      return quoted(firstText(a.query, a.q, a.text), max);
    case 'web_fetch':
    case 'fetch':
      return truncateToolText(a.url || a.uri || '', max);
    case 'crawl':
      return truncateToolText(firstText(a.url, a.start_url, a.startUrl, a.uri), max);
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
    case 'agent':
    case 'task':
      return compactParts([
        a.type || a.action || a.mode || '',
        a.role || a.name || a.subagent_type || a.tag || a.sessionId || a.jobId || '',
        a.preset ? `preset ${a.preset}` : '',
        compactSlash(a.provider, a.model),
        a.effort ? `effort ${a.effort}` : '',
        a.fast === true ? 'fast' : '',
        truncateSingleLine(firstText(a.description, a.prompt, a.message), Math.min(max, 80)),
      ]);
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
      return truncateToolText(firstText(a.name, a.skill, a.skill_name), max);
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

function countNonEmptyLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim()).length;
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
  const changed = [];
  for (const line of String(text ?? '').split('\n')) {
    const ok = /^\s*OK\s+(modify|add|delete|create)\s+(.+?)(?:\s+([±+\-]\S+))?\s*$/i.exec(line);
    if (ok) {
      changed.push({ action: ok[1].toLowerCase(), path: ok[2].trim(), delta: ok[3] || '' });
      continue;
    }
    const edited = /^\s*(Edited|Created|Updated|Wrote):\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/i.exec(line);
    if (edited) {
      changed.push({ action: edited[1].toLowerCase(), path: edited[2].trim(), delta: edited[3] || '' });
    }
  }
  if (changed.length === 1) {
    const item = changed[0];
    const action = item.action === 'delete' ? 'Deleted' : item.action === 'add' || item.action === 'create' || item.action === 'created' ? 'Created' : 'Updated';
    return compactParts([`${action} ${displayToolPath(item.path)}`, item.delta]);
  }
  if (changed.length > 1) {
    const names = changed.slice(0, 2).map((item) => displayToolPath(item.path)).join(', ');
    const extra = changed.length > 2 ? ` +${changed.length - 2} more` : '';
    return `Updated ${changed.length} files - ${names}${extra}`;
  }

  const parsedArgs = parseToolArgs(args);
  const target = parsedArgs.path ?? parsedArgs.file ?? parsedArgs.file_path ?? '';
  if (target) return `Updated ${displayToolPath(target)}`;
  return null;
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
  const normalized = normalizeToolName(name);

  switch (normalized) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource': {
      if (/^\[image:/i.test(trimmed)) return 'Read image';
      if (!trimmed) return null;
      const n = text.split('\n').length;
      return `Read ${n} ${pluralize(n, 'line')}`;
    }
    case 'write':
    case 'edit':
    case 'apply_patch': {
      const updateSummary = summarizeUpdateResult(text, args);
      if (updateSummary) return updateSummary;
      // Prefer explicit additions/removals hints if the result text states them.
      const add = /(\d+)\s+addition/i.exec(text);
      const rem = /(\d+)\s+removal/i.exec(text);
      if (add || rem) {
        const a = add ? Number(add[1]) : 0;
        const r = rem ? Number(rem[1]) : 0;
        return `Updated - +${a} -${r}`;
      }
      // Else count unified-diff style +/- lines (ignore +++/--- file headers).
      let a = 0;
      let r = 0;
      for (const line of text.split('\n')) {
        if (/^\+\+\+|^---/.test(line)) continue;
        if (/^\+/.test(line)) a += 1;
        else if (/^-/.test(line)) r += 1;
      }
      if (a > 0 || r > 0) return `Updated - +${a} -${r}`;
      return null;
    }
    case 'grep': {
      if (!trimmed || !looksLineOriented(text)) return null;
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `Found ${n} ${pluralize(n, 'match', 'matches')}`;
    }
    case 'glob': {
      if (!trimmed || !looksLineOriented(text)) return null;
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `Found ${n} ${pluralize(n, 'file')}`;
    }
    case 'bash':
    case 'bash_session':
    case 'shell_command': {
      if (!trimmed) return '(no output)';
      return null;
    }
    case 'code_graph': {
      const match = /(\d+)\s+(references|definitions|symbols|callers|callees|results|matches)/i.exec(text);
      if (match) return `Found ${match[1]} ${match[2].toLowerCase()}`;
      return null;
    }
    case 'web_fetch':
    case 'fetch': {
      // Status: require a status-like context (HTTP NNN, "Status: NNN",
      // or "NNN OK"/"NNN Not Found") rather than any bare 3-digit number.
      const status = /(?:HTTP[\s/]*\d?\.?\d?\s*|status[:\s]+)([1-5]\d{2})\b/i.exec(text)
        || /\b([1-5]\d{2})\s+(?:OK|Not\s+Found|Forbidden|Moved|Found|Created|No\s+Content|Bad\s+Request|Unauthorized|Internal)/.exec(text);
      const size = /\b(\d+(?:\.\d+)?\s?(?:[KMGT]?B|bytes))\b/i.exec(text);
      if (size && status) return `Received ${size[1]} (${status[1]})`;
      if (size) return `Received ${size[1]}`;
      if (status) return `Received (${status[1]})`;
      return null;
    }
    case 'search': {
      const match = /(\d+)\s+results?/i.exec(text);
      if (match) {
        const n = Number(match[1]);
        return `Found ${n} ${pluralize(n, 'result')}`;
      }
      return null;
    }
    case 'bridge':
    case 'agent':
    case 'task': {
      const job = /^bridge job:\s*(job_[^\s]+)/mi.exec(text);
      const status = /^status:\s*([^\s(]+)/mi.exec(text);
      const role = /^role:\s*(.+)$/mi.exec(text);
      const preset = /^preset:\s*(.+)$/mi.exec(text);
      const model = /^model:\s*(.+)$/mi.exec(text);
      const limits = /^limits:\s*(.+)$/mi.exec(text);
      const parts = [
        role ? role[1] : '',
        preset ? preset[1] : '',
        model ? model[1] : '',
        status ? status[1] : '',
        limits ? limits[1] : '',
      ].filter(Boolean);
      if (parts.length) return compactParts(parts);
      if (job) return status ? `${job[1]} ${status[1]}` : job[1];
      return null;
    }
    default:
      return null;
  }
}

export function isExplorerSurface(label) {
  return label === 'Read' || label === 'Search';
}

export function isMemorySurface(label) {
  return label === 'Memory';
}
