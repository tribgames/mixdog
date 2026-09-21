import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getPluginData } from '../config.mjs';
import { normalizeOutputPath } from '../tools/builtin/path-utils.mjs';
import { classifyResultKind } from './result-classification.mjs';
import { registerSessionPurgeHook } from './store.mjs';

const TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS = 50_000;
const TOOL_RESULT_PREVIEW_CHARS = 512;
const TOOL_RESULT_SHELL_THRESHOLD_CHARS = 30_000;
const TOOL_RESULT_SEARCH_THRESHOLD_CHARS = 50_000;
const TOOL_RESULT_GREP_THRESHOLD_CHARS = 20_000;
const TOOL_RESULT_MESSAGE_MAX_CHARS = 200_000;
// A structured result's text part only buys context back when it is larger
// than the pointer + preview replacing it; smaller parts stay inline.
const TOOL_RESULT_MIN_PART_OFFLOAD_CHARS = 2_000;
const TOOL_RESULT_OFFLOAD_PREFIX = '[tool output offloaded:';
const OFFLOAD_PRUNE_MIN_AGE_MS = 10 * 60 * 1000;
const ARTIFACT_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// Per-tool persistence limits are per-tool maxResultSizeChars values rather
// than a single global value: grep persists at 20k, glob and list/find_* at
// the 50k system default (deliberately tighter than the common 100k), and
// shell/bash_session/task at 30k. Read/head/tail/diff stay inline
// (Infinity) — they are self-bound by FileRead semantics and the upstream
// READ_MAX_SIZE_BYTES cap, so persisting to a sidecar to be re-read would be
// circular. These values keep context-rich IO tools from turning into "read
// saved output" loops while bounding the per-call inline footprint per CC.
// Skill / skill_view bodies stay inline for the same reason — offloading a
// loaded SKILL.md would force a read loop and defeat the loaded-skill guard.
const INLINE_THRESHOLD_BY_TOOL = new Map([
  ['read', Infinity],
  ['head', Infinity],
  ['tail', Infinity],
  ['diff', Infinity],
  ['skill', Infinity],
  ['skill_view', Infinity],
  ['skills_list', Infinity],
  ['grep', TOOL_RESULT_GREP_THRESHOLD_CHARS],
  ['glob', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
  ['list', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
  ['tree', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
  ['find_files', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
  ['code_graph', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
  ['shell', TOOL_RESULT_SHELL_THRESHOLD_CHARS],
  ['bash_session', TOOL_RESULT_SHELL_THRESHOLD_CHARS],
  ['task', TOOL_RESULT_SHELL_THRESHOLD_CHARS],
]);

function getOffloadThreshold(toolName) {
  const key = String(toolName || '').toLowerCase();
  return INLINE_THRESHOLD_BY_TOOL.get(key) ?? TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS;
}

// A structured (multimodal) result — { content: [{ type:'text', text }, { type:'image', … }] }
// — puts its text in the transcript exactly like a string result, so the same
// per-tool and per-message budgets apply to the text parts. Image parts are the
// reason the tool answered with parts at all and are never offloaded here.
function isTextPart(part) {
  return !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string';
}

function structuredTextParts(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const parts = result.content;
  if (!Array.isArray(parts) || !parts.some(isTextPart)) return null;
  return parts;
}

// Inline text a result costs the transcript, string or structured.
function inlineTextLength(result) {
  if (typeof result === 'string') return result.length;
  const parts = structuredTextParts(result);
  if (!parts) return 0;
  return parts.reduce((total, part) => (isTextPart(part) ? total + part.text.length : total), 0);
}

function isOffloadableTextPart(part) {
  return (
    isTextPart(part) && part.text.length >= TOOL_RESULT_MIN_PART_OFFLOAD_CHARS && !isOffloadedToolResultText(part.text)
  );
}

// Chars still available for reduction: a pointer is never re-offloaded, and a
// part below the pointer's own size would grow the transcript instead.
function offloadableTextLength(result) {
  if (typeof result === 'string') return isOffloadedToolResultText(result) ? 0 : result.length;
  const parts = structuredTextParts(result);
  if (!parts) return 0;
  return parts.reduce((total, part) => (isOffloadableTextPart(part) ? total + part.text.length : total), 0);
}

const AGGREGATE_OFFLOAD_EXCLUDED_TOOLS = new Set([
  'read',
  'head',
  'tail',
  'diff',
  'skill',
  'skill_view',
  'skills_list',
]);

function isAggregateOffloadEligible(toolName, result) {
  if (typeof result !== 'string' && !structuredTextParts(result)) return false;
  const key = String(toolName || '').toLowerCase();
  return !AGGREGATE_OFFLOAD_EXCLUDED_TOOLS.has(key);
}

function rankAggregateOffloadCandidates(entries) {
  return entries
    .map((entry, index) => {
      const length = offloadableTextLength(entry?.result);
      return {
        index,
        length,
        eligible: isAggregateOffloadEligible(entry?.toolName, entry?.result) && length > 0,
      };
    })
    .filter((entry) => entry.eligible)
    .sort((a, b) => b.length - a.length || b.index - a.index)
    .map((entry) => entry.index);
}

// Sanitize sessionId before using it as a path segment. A raw `..` or slash
// would let the sidecar dir — and clearOffloadSession's readdir+unlink — escape
// the tool-results root (arbitrary .txt deletion). Strip to [A-Za-z0-9_-];
// dropping '.' collapses '..' to '__'. Real ids are sess_<digits>, unaffected.
function safeSessionSegment(sessionId) {
  return (
    String(sessionId ?? '')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 200) || '_invalid'
  );
}

function ensureToolResultsDir(sessionId) {
  const dir = join(getPluginData(), 'tool-results', safeSessionSegment(sessionId));
  // R4 data-at-rest: offloaded tool output may contain secrets / file
  // contents; clamp dir to owner-only on POSIX (advisory on Windows).
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function artifactIdentity(sha256) {
  // Session-scoped content addressing lets result/stdout/stderr references
  // share one verified file when their exact bytes are identical.
  return `${sha256}.txt`;
}

function splitsSurrogatePair(text, offset) {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function buildPreview(text, maxChars = TOOL_RESULT_PREVIEW_CHARS) {
  if (text.length <= maxChars) {
    return { preview: text, truncated: false };
  }
  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = maxChars - headBudget;
  const headEnd = headBudget - (splitsSurrogatePair(text, headBudget) ? 1 : 0);
  let head = text.slice(0, headEnd);
  const headCut = head.lastIndexOf('\n');
  if (headCut > Math.floor(headBudget * 0.6)) head = head.slice(0, headCut);
  let tailStart = Math.max(0, text.length - tailBudget);
  if (splitsSurrogatePair(text, tailStart)) tailStart += 1;
  let tail = text.slice(tailStart);
  const tailCut = tail.indexOf('\n');
  if (tailCut !== -1 && tailCut < Math.floor(tailBudget * 0.4)) tail = tail.slice(tailCut + 1);
  const omittedKb = Math.max(1, Math.round((text.length - head.length - tail.length) / 1024));
  return {
    preview: `${head}\n... [preview middle omitted — ${omittedKb} KB] ...\n${tail}`,
    truncated: true,
  };
}

function countLines(text) {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function artifactMeta(sessionId, toolCallId, channel, content) {
  if (!sessionId || !toolCallId || typeof content !== 'string') return null;
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const dir = ensureToolResultsDir(sessionId);
  return {
    stream: channel,
    path: join(dir, artifactIdentity(sha256)),
    bytes: Buffer.byteLength(content, 'utf8'),
    chars: content.length,
    lines: countLines(content),
    sha256,
  };
}

function artifactShapeMatches(meta, info) {
  return info.isFile() && info.size === meta.bytes;
}

export function persistToolResultArtifactSync({ sessionId, toolCallId, channel = 'result', content } = {}) {
  let meta;
  try {
    meta = artifactMeta(sessionId, toolCallId, channel, content);
  } catch {
    return null;
  }
  if (!meta) return null;
  try {
    writeFileSync(meta.path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return null;
    let fd;
    try {
      if (!artifactShapeMatches(meta, lstatSync(meta.path))) return null;
      fd = openSync(meta.path, ARTIFACT_READ_FLAGS);
      if (!artifactShapeMatches(meta, fstatSync(fd))) return null;
      if (createHash('sha256').update(readFileSync(fd)).digest('hex') !== meta.sha256) return null;
    } catch {
      return null;
    } finally {
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {
        return null;
      }
    }
  }
  return meta;
}

async function persistToolResultArtifact({ sessionId, toolCallId, channel = 'result', content } = {}) {
  let meta;
  try {
    meta = artifactMeta(sessionId, toolCallId, channel, content);
  } catch {
    return null;
  }
  if (!meta) return null;
  try {
    await writeFile(meta.path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return null;
    let handle;
    try {
      if (!artifactShapeMatches(meta, await lstat(meta.path))) return null;
      handle = await open(meta.path, ARTIFACT_READ_FLAGS);
      if (!artifactShapeMatches(meta, await handle.stat())) return null;
      if (
        createHash('sha256')
          .update(await handle.readFile())
          .digest('hex') !== meta.sha256
      )
        return null;
    } catch {
      return null;
    } finally {
      try {
        await handle?.close();
      } catch {
        return null;
      }
    }
  }
  return meta;
}

export async function maybeOffloadToolResult(sessionId, toolCallId, toolName, result, options = {}) {
  if (!sessionId || !toolCallId) return result;
  const force = options?.force === true;
  // A structured result is not exempt from the budget — only its image parts are.
  if (typeof result !== 'string') {
    return offloadStructuredTextParts(sessionId, toolCallId, toolName, result, force);
  }
  if (result.startsWith(TOOL_RESULT_OFFLOAD_PREFIX)) return result;
  if (!force && result.length <= getOffloadThreshold(toolName)) return result;
  // Keep error surfaces inline so the model can self-correct without an
  // extra read turn — but only up to the global default. A giant error
  // (e.g. a megabyte of stack/diff/dump) still offloads so it can't blow up
  // context; small errors (the overwhelming majority) stay inline.
  if (!force && classifyResultKind(result) === 'error' && result.length <= TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS)
    return result;

  return offloadText(sessionId, toolCallId, toolName, result, 'result');
}

// Persist one text body and return the pointer + preview that stands in for it.
// Persistence is the reduction commit point: if it did not land and verify, the
// complete text is preserved unchanged.
async function offloadText(sessionId, toolCallId, toolName, text, channel) {
  const artifact = await persistToolResultArtifact({
    sessionId,
    toolCallId,
    channel,
    content: text,
  });
  if (!artifact) return text;

  const { preview, truncated } = buildPreview(text);
  const sizeKb = Math.max(1, Math.round(text.length / 1024));
  const displayPath = normalizeOutputPath(artifact.path);
  const header = `${TOOL_RESULT_OFFLOAD_PREFIX} ${toolName} → ${displayPath} (${sizeKb} KB, ${artifact.lines} lines)]`;
  const suffix = truncated ? '\n[preview truncated; full output preserved at the artifact path above]' : '';
  return `${header}\n\n${preview}${suffix}`;
}

// Largest text part first, until the inline text fits the tool's budget. Part
// order, image parts, and every other field of the result are left as they are,
// so the tool's own envelope still reaches the model.
async function offloadStructuredTextParts(sessionId, toolCallId, toolName, result, force) {
  const parts = structuredTextParts(result);
  if (!parts) return result;
  const threshold = force ? 0 : getOffloadThreshold(toolName);
  let inline = inlineTextLength(result);
  if (inline <= threshold) return result;
  // Error convention reads the very start of the body, so the first text part
  // is the one that classifies the result.
  if (
    !force &&
    classifyResultKind(parts.find(isTextPart).text) === 'error' &&
    inline <= TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS
  )
    return result;

  const order = parts
    .map((_, index) => index)
    .filter((index) => isOffloadableTextPart(parts[index]))
    .sort((a, b) => parts[b].text.length - parts[a].text.length);
  const next = parts.slice();
  let changed = false;
  for (const index of order) {
    const text = next[index].text;
    const replaced = await offloadText(sessionId, toolCallId, toolName, text, `result-part-${index}`);
    if (replaced === text) continue;
    next[index] = { ...next[index], text: replaced };
    inline += replaced.length - text.length;
    changed = true;
    if (inline <= threshold) break;
  }
  return changed ? { ...result, content: next } : result;
}

// Apply per-tool persistence first, then enforce the message-level
// budget across the remaining non-Read text results. Selection is
// largest-first; ties prefer the latest result in the assistant tool batch.
export async function maybeOffloadToolResultBatch(sessionId, entries, options = {}) {
  const source = Array.isArray(entries) ? entries : [];
  const maxChars =
    Number(options.maxAggregateChars) > 0
      ? Math.trunc(Number(options.maxAggregateChars))
      : TOOL_RESULT_MESSAGE_MAX_CHARS;
  const applyPerToolLimits = options.applyPerToolLimits !== false;
  const offloadResult = typeof options.offloadResult === 'function' ? options.offloadResult : maybeOffloadToolResult;
  const states = source.map((entry) => ({ result: entry?.result, error: null }));

  if (applyPerToolLimits) {
    await Promise.all(
      source.map(async (entry, index) => {
        try {
          states[index].result = await offloadResult(sessionId, entry?.toolCallId, entry?.toolName, entry?.result, {
            force: false,
          });
        } catch (error) {
          states[index].error = error;
        }
      })
    );
  }

  const inlineChars = () =>
    states.reduce(
      (total, state, index) =>
        state.error || !isAggregateOffloadEligible(source[index]?.toolName, state.result)
          ? total
          : total + inlineTextLength(state.result),
      0
    );
  let total = inlineChars();
  const attempted = new Set();
  while (total > maxChars) {
    const ranked = rankAggregateOffloadCandidates(
      source.map((entry, index) => ({
        toolName: entry?.toolName,
        result: states[index].error || attempted.has(index) ? null : states[index].result,
      }))
    );
    if (ranked.length === 0) break;
    const index = ranked[0];
    attempted.add(index);
    const before = states[index].result;
    try {
      states[index].result = await offloadResult(
        sessionId,
        source[index]?.toolCallId,
        source[index]?.toolName,
        before,
        { force: true }
      );
      total += inlineTextLength(states[index].result) - inlineTextLength(before);
    } catch (error) {
      states[index].error = error;
      total -= inlineTextLength(before);
    }
  }
  return states;
}

function clearOffloadSessionSync(sessionId) {
  if (!sessionId) return;
  const dir = join(getPluginData(), 'tool-results', safeSessionSegment(sessionId));
  if (!existsSync(dir)) return;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {}
    }
    try {
      rmdirSync(dir);
    } catch {}
  } catch {
    /* hard-delete cleanup is best-effort */
  }
}

// Canonical lifecycle boundary: normal close keeps resumable artifacts;
// deleteSession runs purge hooks only after the session record is truly gone.
registerSessionPurgeHook(clearOffloadSessionSync);

// Remove sidecars that no longer occur in the live transcript. A serialized
// path match is conservative: if messages cannot be serialized, or a path is
// mentioned anywhere in a message, retain the file rather than risk deleting
// one that can still be read by the model.
export async function pruneOffloadSession(sessionId, getMessages) {
  if (!sessionId || typeof getMessages !== 'function') return;
  const dir = join(getPluginData(), 'tool-results', safeSessionSegment(sessionId));
  if (!existsSync(dir)) return;
  let candidates;
  try {
    const entries = await readdir(dir);
    candidates = (
      await Promise.all(
        entries
          .filter((name) => name.endsWith('.txt'))
          .map(async (name) => {
            const filePath = join(dir, name);
            try {
              const fileStat = await stat(filePath);
              if (Date.now() - fileStat.mtimeMs < OFFLOAD_PRUNE_MIN_AGE_MS) return null;
              return { name, filePath };
            } catch {
              return null;
            }
          })
      )
    ).filter(Boolean);
  } catch {
    /* best-effort */
  }
  if (!candidates) return;
  let serialized;
  try {
    serialized = JSON.stringify(getMessages());
  } catch {
    return;
  }
  const haystack = process.platform === 'win32' ? serialized.toLowerCase() : serialized;
  // Compact archives may themselves reference older archives or offloaded
  // results. Keep the reachable graph, not just directly visible files.
  const reachable = new Set(haystack.match(/\b[a-f0-9]{64}\.txt\b/g) || []);
  const pending = [...reachable];
  for (let i = 0; i < pending.length; i += 1) {
    let text;
    try {
      text = await readFile(join(dir, pending[i]), 'utf8');
    } catch {
      return;
    } // An unreadable root must not destroy recovery evidence.
    for (const name of text.match(/\b[a-f0-9]{64}\.txt\b/g) || []) {
      if (reachable.has(name)) continue;
      reachable.add(name);
      pending.push(name);
    }
  }
  await Promise.all(
    candidates
      .filter(({ name, filePath }) => {
        if (reachable.has(name)) return false;
        const normalizedPath = normalizeOutputPath(filePath);
        const needles = [normalizedPath, name];
        return !needles.some((needle) => {
          const value = process.platform === 'win32' ? needle.toLowerCase() : needle;
          return haystack.includes(value);
        });
      })
      .map(({ filePath }) =>
        unlink(filePath).catch(() => {
          /* best-effort */
        })
      )
  );
}

export function isOffloadedToolResultText(text) {
  return typeof text === 'string' && text.startsWith(TOOL_RESULT_OFFLOAD_PREFIX);
}

export function compactOffloadedToolResultText(text) {
  if (!isOffloadedToolResultText(text)) return text;
  const value = String(text);
  const lineEnd = value.indexOf('\n');
  const firstLine = lineEnd === -1 ? value : value.slice(0, lineEnd);
  return `${firstLine}\n[preview omitted; full output preserved at the artifact path above]`;
}

export const _internals = {
  TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS,
  TOOL_RESULT_SHELL_THRESHOLD_CHARS,
  TOOL_RESULT_SEARCH_THRESHOLD_CHARS,
  TOOL_RESULT_GREP_THRESHOLD_CHARS,
  getOffloadThreshold,
  TOOL_RESULT_PREVIEW_CHARS,
  TOOL_RESULT_MESSAGE_MAX_CHARS,
  TOOL_RESULT_MIN_PART_OFFLOAD_CHARS,
  buildPreview,
  countLines,
  inlineTextLength,
  offloadableTextLength,
};
