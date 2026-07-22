// Row-estimate helpers for transcript items, extracted from transcript-window.mjs.
import {
  measureMarkdownRenderedRows,
  measureStreamingMarkdownRenderedRows,
} from '../markdown/measure-rendered-rows.mjs';
import { streamingLayoutText } from '../markdown/streaming-markdown.mjs';
import { displayWidth } from '../display-width.mjs';
import { formatToolSurface, normalizeToolName, parseToolArgs, summarizeAgentSurfaceBrief } from '../../runtime/shared/tool-surface.mjs';
import { isBackgroundErrorOnlyBody } from '../../runtime/shared/err-text.mjs';
import { formatExpandedResult, wrapExpandedResultLines } from '../components/tool-output-format.mjs';
import {
  formatHookDenialDetail,
  isHookApprovalDenialToolItem,
  shouldSuppressFullyFailedToolItem,
  toolItemResultText,
} from '../transcript-tool-failures.mjs';

// Count how many terminal rows ONE logical line (no '\n') occupies once ink
// word-wraps it. Mirror the greedy word-wrap so the row estimate is never lower
// than what ink actually renders.
export function wrappedLineRows(line, width) {
  const text = String(line);
  const full = displayWidth(text);
  if (full === 0) return 1;
  if (full <= width) return 1;
  let rows = 1;
  let col = 0;
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    const tw = displayWidth(token);
    if (tw === 0) continue;
    if (tw > width) {
      // Over-long unbreakable token: ink hard-splits it across rows.
      if (col > 0) { rows++; col = 0; }
      rows += Math.ceil(tw / width) - 1;
      col = tw % width || width;
      continue;
    }
    if (col + tw > width) { rows++; col = tw; }
    else { col += tw; }
  }
  return Math.max(1, rows);
}

function estimateWrappedRows(text, columns, reserve = 4) {
  const width = Math.max(8, Number(columns || 80) - reserve);
  const lines = String(text ?? '').split('\n');
  return Math.max(1, lines.reduce((sum, line) => sum + wrappedLineRows(line, width), 0));
}

export const SKILL_SURFACE_NAMES = new Set([
  'skill', 'skill_execute', 'skill_view', 'skills_list', 'use_skill',
]);

function isAgentResponseResultText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)(?:\s*·\s*task_id:\s*\S+)?$/i.test(value)) return false;
  if (/^(?:background task\b|agent task:|task_id:)/i.test(value) && !/\n\s*\n[\s\S]*\S/.test(value)) return false;
  return true;
}

const BACKGROUND_TASK_TOOL_NAMES = new Set(['explore', 'search', 'shell', 'bash', 'bash_session', 'shell_command', 'task']);

function isBackgroundTaskToolName(normalizedName) {
  return BACKGROUND_TASK_TOOL_NAMES.has(String(normalizedName || '').toLowerCase());
}

function parseBackgroundTaskResultForRows(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const allLines = text.split('\n');
  const start = allLines.findIndex((line) => line.trim() === 'background task');
  if (start < 0) return null;
  const rest = allLines.slice(start + 1);
  const blank = rest.findIndex((line) => !line.trim());
  const headLines = blank >= 0 ? rest.slice(0, blank) : rest;
  const body = blank >= 0 ? rest.slice(blank + 1).join('\n').trim() : '';
  const fields = {};
  for (const line of headLines) {
    const match = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  const status = String(fields.status || '').toLowerCase();
  const error = String(fields.error || '').trim();
  const errorOnlyBody = isBackgroundErrorOnlyBody(body, error);
  return {
    status,
    body,
    error,
    errorOnlyBody,
    hasResponse: Boolean(body) && !errorOnlyBody && !/^(running|pending|queued)$/i.test(status),
  };
}

function isBackgroundTaskResponseArgsForRows(normalizedName, args = {}) {
  if (!isBackgroundTaskToolName(normalizedName)) return false;
  const type = String(args?.type || args?.action || '').toLowerCase();
  const status = String(args?.status || '').toLowerCase();
  return type === 'result' || type === 'completion' || (/^(completed|cancelled|canceled)$/i.test(status) && Boolean(args?.task_id));
}

// ToolExecution derives its background-task classification from
// formatToolSurface(name, args).args — parseToolArgs(args). The row estimate /
// variant key must read the SAME parsed shape. parseToolArgs already guards
// malformed input (returns {} / { value } without throwing).
// Hot path: the rows helpers re-read args many times per item per index pass,
// and parseToolArgs JSON.parses the same raw string each call (6.6% of frame
// CPU in the 11k-item load bench). Raw-string-keyed memo; entries are treated
// as READ-ONLY by every caller in this module.
const parsedArgsByRaw = new Map(); // raw args string → parsed object
const PARSED_ARGS_CACHE_MAX = 1024;
export function backgroundArgsForRows(rawArgs) {
  if (typeof rawArgs === 'string' && rawArgs) {
    let parsed = parsedArgsByRaw.get(rawArgs);
    if (parsed === undefined) {
      const raw = parseToolArgs(rawArgs);
      parsed = raw && typeof raw === 'object' ? raw : {};
      if (parsedArgsByRaw.size >= PARSED_ARGS_CACHE_MAX) {
        parsedArgsByRaw.delete(parsedArgsByRaw.keys().next().value);
      }
      parsedArgsByRaw.set(rawArgs, parsed);
    }
    return parsed;
  }
  const parsed = parseToolArgs(rawArgs);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function toolItemPendingForRows(item) {
  const count = Math.max(1, Number(item?.count || 1));
  const done = Math.max(0, Math.min(count, Number(item?.completedCount || (item?.result == null ? 0 : count))));
  return done < count;
}

export const LEADING_STATUS_MARKER_LINE_RE = /^\[status:\s*[^\]]*\]\s*$/i;

function stripLeadingStatusMarkerFromTextForRows(text) {
  const lines = String(text || '').split('\n');
  if (lines.length > 0 && LEADING_STATUS_MARKER_LINE_RE.test(String(lines[0] ?? '').trim())) lines.shift();
  return lines.join('\n');
}

function toolDisplayedResultTextForRows(item) {
  const rt = item?.result == null ? '' : String(item.result).replace(/\s+$/, '');
  const bgArgs = backgroundArgsForRows(item?.args);
  const backgroundError = String(bgArgs.error || '');
  const errorOnlyResult = Boolean(rt) && isBackgroundErrorOnlyBody(rt, backgroundError);
  const normalizedName = String(normalizeToolName(item?.name) || '').toLowerCase();
  if (!toolItemPendingForRows(item) && isBackgroundTaskToolName(normalizedName)) {
    const meta = parseBackgroundTaskResultForRows(rt);
    if (meta?.hasResponse && String(meta.body || '').trim()) {
      return stripLeadingStatusMarkerFromTextForRows(String(meta.body));
    }
  }
  return stripLeadingStatusMarkerFromTextForRows(errorOnlyResult ? '' : (rt || ''));
}

function toolHasDisplayResultForRows(item) {
  const rt = item.result == null ? '' : String(item.result).replace(/\s+$/, '');
  const trimmed = String(rt || '').trim();
  if (!trimmed) return false;
  const bgArgs = backgroundArgsForRows(item.args);
  if (isBackgroundErrorOnlyBody(trimmed, bgArgs.error || '')) return false;
  const normalizedName = String(normalizeToolName(item.name) || '').toLowerCase();
  if (isBackgroundTaskToolName(normalizedName)) {
    const meta = parseBackgroundTaskResultForRows(trimmed);
    if (meta) return Boolean(meta.hasResponse && String(meta.body || '').trim());
  }
  return true;
}

function toolExpandedRawTextForRows(item, rawRt) {
  if (item?.aggregate) return rawRt;
  if (item?.agentResponseAggregate) return rawRt;
  const hasDisplayResult = toolHasDisplayResultForRows(item);
  if (hasDisplayResult) return toolDisplayedResultTextForRows(item);
  return stripLeadingStatusMarkerFromTextForRows(rawRt || '');
}

function toolHeaderFailureOnlyForRows(item, normalizedName, hasDisplayResult) {
  if (hasDisplayResult) return false;
  const bgArgs = backgroundArgsForRows(item.args);
  const error = String(bgArgs.error || '').trim();
  if (!error) return false;
  if (normalizedName === 'agent') {
    const pending = toolItemPendingForRows(item);
    const isError = Boolean(item.isError);
    const agentHeaderFailure = !pending && isError && error && !hasDisplayResult;
    if (!agentHeaderFailure) return false;
    const displayedResultText = toolDisplayedResultTextForRows(item);
    const rt = item.result == null ? '' : String(item.result).replace(/\s+$/, '');
    const isAgentResult = !pending && hasDisplayResult;
    const isAgentResponse = isAgentResult && isAgentResponseResultText(rt);
    const briefRaw = summarizeAgentSurfaceBrief(item.name, bgArgs, displayedResultText, {
      isError,
      isResponse: isAgentResponse,
    });
    const agentSurfaceBriefNonempty = Boolean(String(briefRaw || '').trim());
    return !agentSurfaceBriefNonempty;
  }
  if (!isBackgroundTaskToolName(normalizedName) || !bgArgs.task_id) return false;
  if (isBackgroundTaskResponseArgsForRows(normalizedName, bgArgs)) return false;
  const status = String(bgArgs.status || '').toLowerCase();
  return /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(status);
}

function toolArgPathForRows(item) {
  const a = backgroundArgsForRows(item?.args);
  return a?.path ?? a?.file_path ?? a?.file ?? '';
}

// Mirror ToolExecution's collapsed agent-card rule: an agent surface collapses
// to a SINGLE header row unless the detail row carries failure info (the call
// errored, or the brief/status reads as a failure/cancel). Pending agent cards
// never carry failure info yet, so they collapse to one row. A header-failure-
// only card is handled earlier by toolHeaderFailureOnlyForRows (also one row).
function agentCardKeepsCollapsedDetailForRows(item, normalizedName) {
  if (normalizedName !== 'agent') return false;
  if (toolItemPendingForRows(item)) return false;
  const bgArgs = backgroundArgsForRows(item.args);
  const isError = Boolean(item.isError);
  const hasDisplayResult = toolHasDisplayResultForRows(item);
  const displayedResultText = toolDisplayedResultTextForRows(item);
  const rt = item.result == null ? '' : String(item.result).replace(/\s+$/, '');
  const isAgentResponse = hasDisplayResult && isAgentResponseResultText(rt);
  const briefRaw = summarizeAgentSurfaceBrief(item.name, bgArgs, displayedResultText, {
    isError,
    isResponse: isAgentResponse,
  });
  const brief = String(briefRaw || '').trim();
  const status = String(bgArgs.status || '').toLowerCase();
  const failureText = /\b(cancelled|canceled|failed)\b/i.test(brief)
    || /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(status);
  const agentHeaderFailure = isError && String(bgArgs.error || '').trim() && !hasDisplayResult;
  if (agentHeaderFailure && !brief) return false;
  return isError || failureText;
}

function isShellSurfaceForRows(normalizedName, label = '') {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return n === 'shell' || n === 'bash' || n === 'bash_session'
    || n === 'shell_command' || n === 'job_wait' || l === 'run';
}

function isShellSurfaceForToolItem(item, normalizedName) {
  const label = formatToolSurface(item?.name, item?.args)?.label || '';
  return isShellSurfaceForRows(normalizedName, label);
}

// EXPANDED tool bodies are post-processed by formatExpandedResult; the row
// estimate MUST run the SAME pipeline. Pass pathArg/isShell so the count matches.
function estimateToolRenderedResultRows(value, { pathArg = '', isShell = false, columns = 80 } = {}) {
  const text = String(value ?? '').replace(/\s+$/, '');
  if (!text) return 1;
  try {
    const logical = formatExpandedResult(text, { pathArg, isShell });
    const rows = wrapExpandedResultLines(logical, columns, { isShell }).length;
    return Math.max(1, rows);
  } catch {
    return Math.max(1, text.split('\n').length);
  }
}

export function estimateTranscriptItemRows(item, columns, toolOutputExpanded, attachedTool = false) {
  if (!item) return 1;
  switch (item.kind) {
    case 'user':
      return 1 + estimateWrappedRows(item.text, columns, 4);
    case 'assistant':
      // marginTop={1} (AssistantMessage <Box>) + rendered body height.
      return 1 + (item.streaming
        ? measureStreamingMarkdownRenderedRows(item.text, columns, item.id)
        : measureMarkdownRenderedRows(item.text, columns));
    case 'tool': {
      // Consecutive tool cards render attached (marginTop 0) — see
      // TranscriptItem's attached={prevKind === 'tool'}.
      const TOOL_MARGIN_TOP = attachedTool ? 0 : 1;
      if (shouldSuppressFullyFailedToolItem(item)) return 0;
      if (isHookApprovalDenialToolItem(item)) {
        const detail = formatHookDenialDetail(toolItemResultText(item));
        return TOOL_MARGIN_TOP + 1 + (detail ? 1 : 0);
      }
      const normalizedName = String(normalizeToolName(item.name) || '').toLowerCase();
      const count = Math.max(1, Number(item.count || 1));
      const done = Math.max(0, Math.min(count, Number(item.completedCount || (item.result == null ? 0 : count))));
      const pending = done < count;
      const isSkillSurface = !item.aggregate && SKILL_SURFACE_NAMES.has(normalizedName);
      const isAgentSurface = normalizedName === 'agent';
      const rt = item.result == null ? null : String(item.result).replace(/\s+$/, '');
      const rawRt = item.rawResult == null ? null : String(item.rawResult).replace(/\s+$/, '');
      const hasResult = item.result != null && Boolean(String(rt || '').trim());
      const hasRawResult = item.rawResult != null && Boolean(String(rawRt || '').trim());
      const expanded = toolOutputExpanded || item.expanded;
      if (!expanded || pending) {
        if (isSkillSurface) return TOOL_MARGIN_TOP + 1;
        const hasDisplayResult = toolHasDisplayResultForRows(item);
        if (toolHeaderFailureOnlyForRows(item, normalizedName, hasDisplayResult)) {
          return TOOL_MARGIN_TOP + 1;
        }
        if (isAgentSurface) {
          return agentCardKeepsCollapsedDetailForRows(item, normalizedName)
            ? TOOL_MARGIN_TOP + 1 + 1
            : TOOL_MARGIN_TOP + 1;
        }
        return TOOL_MARGIN_TOP + 1 + 1;
      }
      if (hasRawResult) {
        const estimateText = toolExpandedRawTextForRows(item, rawRt);
        const rawOpts = item.aggregate
          ? {}
          : { pathArg: toolArgPathForRows(item), isShell: isShellSurfaceForToolItem(item, normalizedName) };
        return TOOL_MARGIN_TOP + 1 + estimateToolRenderedResultRows(estimateText, { ...rawOpts, columns });
      }
      if (isAgentSurface && !hasResult) {
        return agentCardKeepsCollapsedDetailForRows(item, normalizedName)
          ? TOOL_MARGIN_TOP + 1 + 1
          : TOOL_MARGIN_TOP + 1;
      }
      if (isSkillSurface && !hasResult) return TOOL_MARGIN_TOP + 1;
      if (item.aggregate) {
        if (hasRawResult) {
          const resultRows = estimateToolRenderedResultRows(rawRt, { columns });
          return TOOL_MARGIN_TOP + 1 + resultRows;
        }
        return TOOL_MARGIN_TOP + 1 + 1;
      } else {
        const backgroundMeta = hasResult && isBackgroundTaskToolName(normalizedName)
          ? parseBackgroundTaskResultForRows(rt)
          : null;
        const isBackgroundResult = hasResult && isBackgroundTaskToolName(normalizedName);
        const isBackgroundResponse = isBackgroundResult
          && (backgroundMeta?.hasResponse || isBackgroundTaskResponseArgsForRows(normalizedName, backgroundArgsForRows(item.args)));
        const isBackgroundMetadataResult = isBackgroundResult && !isBackgroundResponse && Boolean(backgroundMeta);
        if (isBackgroundMetadataResult) {
          const hasDisplayResult = toolHasDisplayResultForRows(item);
          if (toolHeaderFailureOnlyForRows(item, normalizedName, hasDisplayResult)) {
            return TOOL_MARGIN_TOP + 1;
          }
          return isSkillSurface ? TOOL_MARGIN_TOP + 1 : TOOL_MARGIN_TOP + 1 + 1;
        }
        const resultText = backgroundMeta?.hasResponse ? backgroundMeta.body : rt;
        const resultRows = estimateToolRenderedResultRows(resultText, {
          pathArg: toolArgPathForRows(item),
          isShell: isShellSurfaceForToolItem(item, normalizedName),
          columns,
        });
        return TOOL_MARGIN_TOP + 1 + resultRows;
      }
    }
    case 'notice':
      return 1 + estimateWrappedRows(item.text, columns, 6);
    case 'turndone':
    case 'statusdone':
      return 2;
    default:
      return 1;
  }
}
