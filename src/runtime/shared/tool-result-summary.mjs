import {
  AGENT_SURFACE_BRIEF_MAX,
  STATUS_SEPARATOR,
  compactParts,
  displayToolPath,
  firstText,
  isMcpToolName,
  normalizeToolName,
  parseToolArgs,
  pluralize,
  titleStatus,
  titleWord,
  truncateSingleLine,
  truncateToolText,
  displayAgentName,
  displayModelName,
} from './tool-primitives.mjs';

function countNonEmptyLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim()).length;
}

// Zero-result recognizer (audit HIGH): result text that SAYS "nothing found"
// must summarize as an explicit zero, not be line-counted into "1 match".
// Matches the shapes emitted by grep/glob/find/list/recall backends:
//   "(no matches)", "no matches found", "(no results)", "No results",
//   "(no fuzzy match for \"...\")", "0 matches", "(empty)", "(no entries)".
function looksLikeZeroResultText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return false;
  // Only trust short, single-line-ish payloads — a real listing that merely
  // CONTAINS the words "no matches" somewhere must not be zeroed.
  if (trimmed.length > 200 || trimmed.includes('\n')) return false;
  return /^\(?\s*(?:no|0)\s+(?:fuzzy\s+)?(?:match(?:es)?|results?|files?|entries|candidates?|hits?)\b/i.test(trimmed)
    || /^\(?\s*(?:empty|none)\s*\)?$/i.test(trimmed)
    || /^no\s+\S+\s+(?:found|matched)\b/i.test(trimmed);
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

export function parseLineDelta(delta) {
  const totals = { added: 0, removed: 0, seen: false };
  for (const match of String(delta ?? '').matchAll(/([+-])\s*(\d+)\s*(?:line|lines)?/gi)) {
    const n = Number(match[2]) || 0;
    totals.seen = true;
    if (match[1] === '+') totals.added += n;
    else totals.removed += n;
  }
  return totals;
}

export function formatLineDelta(totals) {
  if (!totals?.seen) return '';
  const added = Number(totals.added) || 0;
  const removed = Number(totals.removed) || 0;
  if (added === 0 && removed === 0) return '';
  const parts = [];
  if (added > 0) parts.push(`+${added} ${pluralize(added, 'line')}`);
  if (removed > 0) parts.push(`-${removed} ${pluralize(removed, 'line')}`);
  return parts.join(STATUS_SEPARATOR);
}

export function parseUpdateSummary(text) {
  const match = /^(Updated|Created|Deleted|Checked)\s+(.+?)(?:\s+·\s+|$)/i.exec(String(text || '').trim());
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
        if (/^(?:agent task|status|type|target|role|agent|preset|model|effort|fast|limits|session|task-id|task_id|notification|queueDepth|worker|worker_stage|last_progress|silent_for|watchdog|queued_followups|diagnostic|started|finished|elapsed|reused):\s*/i.test(trimmed)) continue;
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
        if (status) return truncateSingleLine(titleStatus(status), AGENT_SURFACE_BRIEF_MAX);
        if (parsed.cwd) return truncateSingleLine(parsed.cwd, AGENT_SURFACE_BRIEF_MAX);
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
  return truncateSingleLine(line, AGENT_SURFACE_BRIEF_MAX);
}

// Error-cause extractor (audit HIGH): when a tool result is an error, surface
// the actual cause line instead of a bare "Failed"/raw first line. Handles
// JSON error envelopes ({error|message|cause|detail}) and plain-text bodies
// (first line that carries error-ish signal, else first non-empty line).
// Exported for ToolExecution's collapsed detail row.
export function extractErrorCause(resultText) {
  const text = String(resultText ?? '').trim();
  if (!text) return '';
  // JSON envelope: prefer explicit error-ish keys.
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (obj && typeof obj === 'object') {
        const cause = firstText(
          typeof obj.error === 'string' ? obj.error : obj.error?.message,
          obj.message, obj.cause, obj.detail, obj.reason, obj.status,
        );
        if (cause) return truncateSingleLine(String(cause), AGENT_SURFACE_BRIEF_MAX);
      }
    } catch { /* fall through to text scan */ }
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // Prefer the first line that looks like an error statement.
  const errorish = lines.find((l) => /\b(error|failed|failure|denied|refused|timed?\s*out|timeout|not\s+found|missing|invalid|cannot|can't|exception|exit\s+(?:code\s+)?[1-9])\b/i.test(l));
  const picked = errorish || lines[0] || '';
  return truncateSingleLine(stripInlineMarkdown(picked), AGENT_SURFACE_BRIEF_MAX);
}

/**
 * Derive a short semantic one-liner for a completed tool call using only the
 * tool name, parsed args, and the raw result text. Returns null when nothing
 * reliable can be derived, so the caller falls back to the raw result block.
 */
export function summarizeToolResult(name, args, resultText, isError = false) {
  if (isError) {
    // Audit HIGH: errors used to disable semantic summaries entirely, leaving
    // the UI with a raw first line or a bare "Failed". Surface the extracted
    // cause so the collapsed card answers "why" without ctrl+o.
    const cause = extractErrorCause(resultText);
    return cause || null;
  }
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
      if (looksLikeZeroResultText(text)) return '0 matches';
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `${n} ${pluralize(n, 'match', 'matches')}`;
    }
    case 'glob': {
      if (!trimmed || !looksLineOriented(text)) return null;
      if (looksLikeZeroResultText(text)) return '0 files';
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `${n} ${pluralize(n, 'file')}`;
    }
    case 'find': {
      if (!trimmed || !looksLineOriented(text)) return null;
      if (looksLikeZeroResultText(text)) return '0 candidates';
      const n = countNonEmptyLines(text);
      if (n === 0) return null;
      return `${n} ${pluralize(n, 'candidate')}`;
    }
    case 'list':
    case 'ls': {
      if (!trimmed || !looksLineOriented(text)) return null;
      if (looksLikeZeroResultText(text)) return '0 entries';
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
      return truncateSingleLine(firstLine, AGENT_SURFACE_BRIEF_MAX);
    }
    case 'code_graph': {
      const match = /(\d+)\s+(references|definitions|symbols|callers|callees|results|matches)/i.exec(text);
      if (match) return `${match[1]} ${String(match[2]).toLowerCase()}`;
      if (looksLikeZeroResultText(text)) return 'No results';
      return null;
    }
    case 'web_fetch':
    case 'fetch': {
      // Audit HIGH: channel `fetch` (Discord message fetch — args carry
      // channel/messageId/limit, never url/uri) was summarized as a WEB fetch,
      // so its result missed both the status/size probes and fell to raw JSON.
      // Route it to the generic JSON/text summarizer instead.
      if (normalized === 'fetch') {
        const a = parseToolArgs(args);
        const isChannelFetch = !firstText(a.url, a.uri)
          && Boolean(firstText(a.channel, a.channelId, a.chatId, a.messageId) || a.limit != null);
        if (isChannelFetch) {
          const n = countNonEmptyLines(text);
          if (trimmed && looksLineOriented(text) && n > 0) return `${n} ${pluralize(n, 'message')}`;
          return summarizeGenericResult(text);
        }
      }
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
    case 'memory': {
      if (!trimmed || trimmed === '(no results)' || looksLikeZeroResultText(text)) return 'No Results';
      let n = 0;
      for (const line of text.split('\n')) {
        if (/#\d+\s*$/.test(line)) n += 1;
      }
      if (n > 0) return `${n} ${pluralize(n, 'Memory', 'Memories')}`;
      return summarizeGenericResult(text);
    }
    case 'remember':
    case 'save_memory':
    case 'update_memory':
    case 'reply':
    case 'request_user_input':
    case 'update_plan':
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
      const statusMatch = /^status:\s*([^\s(]+)/mi.exec(text);
      // Defensive twin of the render-side guard: an envelope that still says
      // "status: undefined"/"null" must not surface a titleized "Undefined".
      const status = statusMatch && !/^(?:undefined|null)$/i.test(statusMatch[1]) ? statusMatch : null;
      const agent = /^agent:\s*(.+)$/mi.exec(text);
      const preset = /^preset:\s*(.+)$/mi.exec(text);
      const model = /^model:\s*(.+)$/mi.exec(text);
      const limits = /^limits:\s*(.+)$/mi.exec(text);
      const agentModel = compactParts([
        displayAgentName(agent ? agent[1] : ''),
        displayModelName(model ? model[1] : ''),
      ]);
      if (agentModel) return agentModel;
      const parts = [
        task ? task[1] : '',
        agent ? agent[1] : '',
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
