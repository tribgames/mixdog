/**
 * transcript-window.mjs — the transcript row-estimate + virtual-window engine,
 * extracted verbatim from App.jsx. Owns ALL module-level caches for this
 * cluster (variant-key, estimated-rows, measured-rows, sig-part). Pure module:
 * no React, no App closures. The App imports the functions and (for the
 * measured-height cache it writes from a layout effect) the shared cache +
 * variant-key helper by name.
 *
 * Behavior is byte-for-byte the same as when these lived in App.jsx; only the
 * home moved. The env-tunable constants and their comments are preserved.
 */
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

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// Per-keystroke render cost is proportional to the number of MOUNTED transcript
// items: ink's renderNodeToOutput still serializes (squashTextNodes/wrapText/
// output.write) every child even when an overflow:hidden viewport clips it
// off-screen — clipping only trims write coordinates, not the serialization. So
// the only lever for typing latency on a tall transcript is mounting fewer
// rows. The window keeps a small ITEM floor (so a few items stay mounted for
// stable scroll/overscan) but is otherwise driven by the viewport+overscan ROW
// span, not a large fixed item count. All three are env-tunable for A/B / revert.
export const TRANSCRIPT_WINDOW_MIN_ITEMS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_WINDOW_MIN_ITEMS', 12);
export const TRANSCRIPT_WINDOW_OVERSCAN_ROWS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_OVERSCAN_ROWS', 16);

// Hard cap on simultaneously MOUNTED transcript items. Every mounted child is
// fully serialized by ink each frame (clipping only trims write coords, not the
// serialize pass), so this cap is the dominant lever for per-frame render cost
// on a tall transcript. The viewport+overscan ROW span already drives the
// window; this cap only bounds the worst case (many short rows). 180 mounted
// rows is far more than any viewport needs and made each frame serialize a long
// tail of off-screen rows, so lower it to a value that still comfortably covers
// viewport + overscan on a large terminal. Env-tunable for A/B / revert.
export const TRANSCRIPT_WINDOW_MAX_ITEMS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_WINDOW_ITEMS', 80);
export const SELECTION_PAINT_INTERVAL_MS = positiveIntEnv('MIXDOG_TUI_SELECTION_PAINT_MS', 24);
// Frame-coalesce edge-drag auto-scroll + wheel scroll: both paths accumulate
// deltas into one pending total and flush via a single scrollTranscriptRows
// call per this interval, instead of firing the (expensive: anchor recompute +
// selection repaint) scrollTranscriptRows on every mousemove/wheel tick.
export const SCROLL_COALESCE_MS = positiveIntEnv('MIXDOG_TUI_SCROLL_COALESCE_MS', 16);
export const PROMPT_HISTORY_LIMIT = 50;

// Parse a boolean env var that DEFAULTS ON. Any of 0/false/off/no (case-
// insensitive, trimmed) disables it; everything else (including unset) leaves it
// on. Used as the kill switch for the app-level measured-height feature below.
function boolEnvDefaultTrue(name) {
  const raw = process.env[name];
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

export const TRANSCRIPT_MEASURED_ROWS = boolEnvDefaultTrue('MIXDOG_TUI_TRANSCRIPT_MEASURED');

export function selectionRectsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.mode === b.mode
    && a.x1 === b.x1
    && a.y1 === b.y1
    && a.x2 === b.x2
    && a.y2 === b.y2
    && a.clipY1 === b.clipY1
    && a.clipY2 === b.clipY2
    && a.captureText === b.captureText;
}

export function shiftSelectionRectY(rect, deltaY) {
  const dy = Math.round(Number(deltaY) || 0);
  if (!rect || dy === 0) return rect || null;
  return { ...rect, y1: rect.y1 + dy, y2: rect.y2 + dy };
}

// Reading-order compare (row then col): -1 if a<b, 1 if a>b, 0 equal.
export function comparePoints(a, b) {
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.x !== b.x) return a.x < b.x ? -1 : 1;
  return 0;
}

// Count how many terminal rows ONE logical line (no '\n') occupies once ink
// word-wraps it. Mirror the greedy word-wrap so the row estimate is never lower
// than what ink actually renders.
function wrappedLineRows(line, width) {
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

const SKILL_SURFACE_NAMES = new Set([
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
function backgroundArgsForRows(rawArgs) {
  const parsed = parseToolArgs(rawArgs);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function toolItemPendingForRows(item) {
  const count = Math.max(1, Number(item?.count || 1));
  const done = Math.max(0, Math.min(count, Number(item?.completedCount || (item?.result == null ? 0 : count))));
  return done < count;
}

const LEADING_STATUS_MARKER_LINE_RE = /^\[status:\s*[^\]]*\]\s*$/i;

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

function estimateTranscriptItemRows(item, columns, toolOutputExpanded) {
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
      const TOOL_MARGIN_TOP = 1;
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
        return TOOL_MARGIN_TOP + 1 + 1;
      }
      if (hasRawResult) {
        const estimateText = toolExpandedRawTextForRows(item, rawRt);
        const rawOpts = item.aggregate
          ? {}
          : { pathArg: toolArgPathForRows(item), isShell: isShellSurfaceForToolItem(item, normalizedName) };
        return TOOL_MARGIN_TOP + 1 + estimateToolRenderedResultRows(estimateText, { ...rawOpts, columns });
      }
      if (isAgentSurface && !hasResult) return TOOL_MARGIN_TOP + 1 + 1;
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

export function lowerBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function upperBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Resolve the absolute scroll offset that keeps a captured reading anchor at the
// same screen position for the CURRENT prefix table. Pure so it can run during
// render AND in the post-commit layout effect.
export function resolveAnchorScrollOffset({ anchor, items, curPrefix, totalRows, viewRows, maxRows }) {
  if (!anchor || anchor.id == null) return null;
  if (!Array.isArray(curPrefix) || curPrefix.length <= 1) return null;
  const list = Array.isArray(items) ? items : [];
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].id === anchor.id) { idx = i; break; }
  }
  if (idx < 0 || idx > curPrefix.length - 2) return null;
  const itemHeight = Math.max(0, (curPrefix[idx + 1] || 0) - (curPrefix[idx] || 0));
  const clampedOffset = Math.max(0, Math.min(Number(anchor.offset) || 0, itemHeight));
  const anchorRowCur = (curPrefix[idx] || 0) + clampedOffset;
  return Math.max(0, Math.min(maxRows, totalRows - viewRows - anchorRowCur));
}

// Cheap, stable height fingerprint for a text blob (length + newline count +
// FNV-1a hash), so a same-length edit that changes wrap/newline shape still
// invalidates the row/signature caches.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// Two INDEPENDENT 32-bit rolling-hash steps folded into a 64-bit signature.
// fnvStepA is plain FNV-1a; fnvStepB uses a distinct seed/prime + xorshift
// finalizer so the two chains are decorrelated (see the App.jsx history note).
export function fnvStepA(hash, str) {
  let h = hash >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function fnvStepB(hash, str) {
  let h = hash >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x85ebca77) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

function textShapeFingerprint(value) {
  if (value == null) return 'z';
  const text = String(value);
  const len = text.length;
  if (len === 0) return 'e';
  let newlines = 0;
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) === 10) newlines++;
  }
  return `${len}.${newlines}.${fnv1a32(text).toString(36)}`;
}

// Identity-keyed memo for the variant key. Exported: the App's measured-height
// layout effect validates its cache writes on the SAME variant key.
const transcriptVariantKeyCache = new WeakMap();

export function transcriptItemVariantKey(item) {
  if (item && typeof item === 'object') {
    const cached = transcriptVariantKeyCache.get(item);
    if (cached !== undefined) return cached;
    const key = computeTranscriptItemVariantKey(item);
    transcriptVariantKeyCache.set(item, key);
    return key;
  }
  return computeTranscriptItemVariantKey(item);
}

function computeTranscriptItemVariantKey(item) {
  const expanded = item.expanded ? 1 : 0;
  if (item.kind === 'tool') {
    const resultShape = textShapeFingerprint(item.result);
    const rawShape = textShapeFingerprint(item.rawResult);
    const count = Number(item.count ?? 0);
    const completed = item.completedCount === undefined ? 'u' : Number(item.completedCount);
    const errors = item.errorCount === undefined ? 'u' : Number(item.errorCount);
    const isError = item.isError ? 1 : 0;
    const normalizedName = String(normalizeToolName(item.name) || '').toLowerCase();
    const aggregate = item.aggregate ? 1 : 0;
    const bgArgs = backgroundArgsForRows(item.args);
    const bgType = String(bgArgs.type || bgArgs.action || '');
    const bgStatus = String(bgArgs.status || '');
    const bgTaskId = bgArgs.task_id ? 1 : 0;
    const bgPrompt = textShapeFingerprint(bgArgs.prompt);
    const bgMessage = textShapeFingerprint(bgArgs.message);
    const bgError = textShapeFingerprint(bgArgs.error);
    return `x${expanded}:n${normalizedName}:g${aggregate}:r${resultShape}:R${rawShape}:c${count}:d${completed}:e${errors}:E${isError}:bt${bgType}:bs${bgStatus}:bk${bgTaskId}:bp${bgPrompt}:bm${bgMessage}:be${bgError}`;
  }
  return `x${expanded}:s${textShapeFingerprint(item.text ?? item.result ?? '')}`;
}

// Per-item ESTIMATED ROW COUNT cache for buildTranscriptRowIndex.
const transcriptRowsCache = new WeakMap();

// App-level MEASURED row heights (real per-item height cache). Exported so the
// App's per-commit layout effect can write/read/prune it; validated on the same
// (variantKey + columns + toolExpanded) tuple as the estimate caches.
export const transcriptMeasuredRowsCache = new WeakMap();

export function measuredTranscriptRows(item, columns, toolOutputExpanded) {
  if (!TRANSCRIPT_MEASURED_ROWS || !item) return null;
  if (shouldSuppressFullyFailedToolItem(item)) return 0;
  if (item.kind === 'assistant' && item.streaming) return null;
  const entry = transcriptMeasuredRowsCache.get(item);
  if (!entry) return null;
  if (entry.rows <= 0) return null;
  if (entry.columns !== columns) return null;
  if (entry.toolExpanded !== (toolOutputExpanded ? 1 : 0)) return null;
  if (entry.variantKey !== transcriptItemVariantKey(item)) return null;
  return entry.rows;
}

const STREAMING_ROW_QUANTUM = 1;

function assistantTextForStreamingRowEstimate(text) {
  return streamingLayoutText(text);
}

function streamingEstimateRows(item, columns, toolOutputExpanded) {
  const trimmedText = assistantTextForStreamingRowEstimate(item.text);
  const estimateItem = trimmedText === item.text ? item : { ...item, text: trimmedText };
  const raw = Math.max(1, Math.ceil(estimateTranscriptItemRows(estimateItem, columns, toolOutputExpanded)));
  return Math.ceil(raw / STREAMING_ROW_QUANTUM) * STREAMING_ROW_QUANTUM;
}

function estimateTranscriptItemRowsCached(item, columns, toolOutputExpanded) {
  if (!item) return Math.max(1, Math.ceil(estimateTranscriptItemRows(item, columns, toolOutputExpanded)));
  if (shouldSuppressFullyFailedToolItem(item)) return 0;
  if (item.kind === 'assistant' && item.streaming) {
    return streamingEstimateRows(item, columns, toolOutputExpanded);
  }
  const variantKey = transcriptItemVariantKey(item);
  const toolExpanded = toolOutputExpanded ? 1 : 0;
  const cached = transcriptRowsCache.get(item);
  if (cached
    && cached.columns === columns
    && cached.toolExpanded === toolExpanded
    && cached.variantKey === variantKey
    && cached.id === item.id
    && cached.kind === item.kind) {
    return cached.rows;
  }
  const rows = Math.max(1, Math.ceil(estimateTranscriptItemRows(item, columns, toolOutputExpanded)));
  transcriptRowsCache.set(item, { id: item.id, kind: item.kind, variantKey, columns, toolExpanded, rows });
  return rows;
}

export function buildTranscriptRowIndex(items, { columns = 80, toolOutputExpanded = false } = {}) {
  const allItems = Array.isArray(items) ? items : [];
  const rows = new Array(allItems.length);
  const prefixRows = new Array(allItems.length + 1);
  prefixRows[0] = 0;
  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    const measured = measuredTranscriptRows(item, columns, toolOutputExpanded);
    const rowCount = measured != null
      ? measured
      : estimateTranscriptItemRowsCached(item, columns, toolOutputExpanded);
    rows[i] = rowCount;
    prefixRows[i + 1] = prefixRows[i] + rowCount;
  }
  return { rows, prefixRows, totalRows: prefixRows[allItems.length] || 0 };
}

// Stable signature for the transcript row-index / window memos. Changes only
// when transcript STRUCTURE changes or the streaming item's estimated height
// changes — not on every character. Per-item sigParts are identity-memoized.
const transcriptSigPartCache = new WeakMap();

export function transcriptStructureSignature(items, columns, toolOutputExpanded) {
  const list = Array.isArray(items) ? items : [];
  let hA = fnvStepA(0x811c9dc5, `${list.length}|${columns}|${toolOutputExpanded ? 1 : 0}`);
  let hB = fnvStepB(0xcbf29ce4, `${list.length}|${columns}|${toolOutputExpanded ? 1 : 0}`);
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    let sigPart;
    if (!it) {
      sigPart = '_';
    } else if (it.kind === 'assistant' && it.streaming) {
      sigPart = `a${it.id}:${streamingEstimateRows(it, columns, toolOutputExpanded)}`;
    } else {
      const variantKey = transcriptItemVariantKey(it);
      const cached = transcriptSigPartCache.get(it);
      if (cached
        && cached.variantKey === variantKey
        && cached.columns === columns
        && cached.id === it.id
        && cached.kind === it.kind) {
        sigPart = cached.sigPart;
      } else {
        sigPart = `${it.kind?.[0] || '?'}${it.id}:${variantKey}`;
        transcriptSigPartCache.set(it, { id: it.id, kind: it.kind, variantKey, columns, sigPart });
      }
    }
    hA = fnvStepA(hA, `;${i};`);
    hA = fnvStepA(hA, sigPart);
    hB = fnvStepB(hB, `;${i};`);
    hB = fnvStepB(hB, sigPart);
  }
  return `${hA.toString(36)}.${hB.toString(36)}`;
}

export function transcriptRenderWindow(items, { scrollOffset = 0, viewportHeight = 24, columns = 80, toolOutputExpanded = false, rowIndex = null } = {}) {
  const allItems = Array.isArray(items) ? items : [];
  const itemCount = allItems.length;
  const fallbackIndex = rowIndex?.prefixRows?.length === itemCount + 1
    ? rowIndex
    : buildTranscriptRowIndex(allItems, { columns, toolOutputExpanded });
  const totalRows = Math.max(0, fallbackIndex.totalRows || 0);
  const viewRows = Math.max(1, Number(viewportHeight) || 24);
  const maxScrollRows = Math.max(0, totalRows - viewRows);
  const effectiveScrollOffset = Math.min(
    maxScrollRows,
    Math.max(0, Math.ceil(Number(scrollOffset) || 0)),
  );

  const bypassRowBudget = viewRows + TRANSCRIPT_WINDOW_OVERSCAN_ROWS * 2;
  if (itemCount <= TRANSCRIPT_WINDOW_MIN_ITEMS || totalRows <= bypassRowBudget) {
    return { startIndex: 0, endIndex: itemCount, items: allItems, bottomSpacerRows: 0, totalRows, maxScrollRows, effectiveScrollOffset };
  }

  const minItems = Math.min(TRANSCRIPT_WINDOW_MIN_ITEMS, itemCount);
  const maxItems = Math.max(minItems, TRANSCRIPT_WINDOW_MAX_ITEMS);
  const prefixRows = fallbackIndex.prefixRows;
  const visibleTop = Math.max(0, totalRows - effectiveScrollOffset - viewRows);
  const visibleBottom = Math.min(totalRows, totalRows - effectiveScrollOffset);
  const desiredTop = Math.max(0, visibleTop - TRANSCRIPT_WINDOW_OVERSCAN_ROWS);
  const desiredBottom = Math.min(totalRows, visibleBottom + TRANSCRIPT_WINDOW_OVERSCAN_ROWS);

  let startIndex = Math.max(0, upperBound(prefixRows, desiredTop) - 1);
  let endIndex = Math.min(itemCount, Math.max(startIndex + 1, lowerBound(prefixRows, Math.max(desiredBottom, desiredTop + 1))));

  while (endIndex - startIndex < minItems && startIndex > 0) startIndex--;
  while (endIndex - startIndex < minItems && endIndex < itemCount) endIndex++;

  if (endIndex - startIndex > maxItems) {
    const visibleStartIndex = Math.max(0, upperBound(prefixRows, visibleTop) - 1);
    const visibleEndIndex = Math.min(itemCount, Math.max(visibleStartIndex + 1, lowerBound(prefixRows, Math.max(visibleBottom, visibleTop + 1))));
    startIndex = Math.max(0, Math.min(visibleStartIndex, itemCount - maxItems));
    endIndex = Math.min(itemCount, Math.max(visibleEndIndex, startIndex + maxItems));
    if (endIndex - startIndex > maxItems) startIndex = Math.max(0, endIndex - maxItems);
  }

  const bottomSpacerRows = Math.max(0, totalRows - (prefixRows[endIndex] || totalRows));
  return {
    startIndex,
    endIndex,
    items: allItems.slice(startIndex, endIndex),
    bottomSpacerRows,
    totalRows,
    maxScrollRows,
    effectiveScrollOffset,
  };
}
