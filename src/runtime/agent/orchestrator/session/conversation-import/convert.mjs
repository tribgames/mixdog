/**
 * JSONL lines of a foreign conversation → normalized plain-text turns, one
 * line at a time: each parsed record is reduced to its kept plain text and
 * dropped. Tolerates a BOM, CRLF line ends and individual malformed lines
 * (reported as the `malformed` warning). Pure, no IO.
 */
import { createClaudeReducer } from './claude.mjs';
import { createCodexReducer } from './codex.mjs';
import { createDevinReducer } from './devin.mjs';
import {
  IMPORT_ERROR_INTERNAL,
  IMPORT_WARNING_HISTORY_PARTIAL,
  IMPORT_WARNING_MALFORMED,
  conversationTitle,
  normalizeTurns,
} from './turns.mjs';

export const IMPORT_SOURCES = Object.freeze(['codex', 'claude', 'devin']);
/** A line or converted transcript beyond the import limits fails the file. */
export const IMPORT_ERROR_TOO_LARGE = 'tooLarge';
export const IMPORT_MAX_LINE_BYTES = 32 * 1024 * 1024;
/** Bytes read from one source file before it fails as `tooLarge`. */
export const IMPORT_MAX_FILE_BYTES = 256 * 1024 * 1024;
/** Normalized transcript text (the final turns, separators and stub included). */
export const IMPORT_MAX_TRANSCRIPT_CHARS = 4 * 1024 * 1024;
/** Entries a reducer may retain (Claude chain links, Codex turns). */
export const IMPORT_MAX_RETAINED_ENTRIES = 200_000;
/** Bookkeeping a reducer retains besides kept text (ids, links, timestamps). */
export const IMPORT_MAX_METADATA_BYTES = 16 * 1024 * 1024;

export function isImportSource(value) {
  return IMPORT_SOURCES.includes(value);
}

const transcriptChars = (turns) => turns.reduce((total, turn) => total + turn.text.length, 0);

/**
 * Incremental converter. `pushLine(line)` returns false once the conversion
 * is over a limit (`tooLarge`): kept text over `maxTranscriptChars`, retained
 * entries over `maxRetainedEntries` or their bookkeeping over
 * `maxMetadataBytes`; `markTooLarge()` records a limit enforced by the reader
 * (an over-long line or file). `result()` may be called repeatedly and also
 * holds the normalized turns to `maxTranscriptChars`.
 * `errorCode` is null for an importable result, else one of `empty` |
 * `malformed` | `unsupported` | `internalRecord` (the source app's own
 * subagent/review record; `internalKind` names it) | `tooLarge` (whose turns
 * are not returned).
 */
export function createConversationConverter(
  source,
  {
    maxTranscriptChars = IMPORT_MAX_TRANSCRIPT_CHARS,
    maxRetainedEntries = IMPORT_MAX_RETAINED_ENTRIES,
    maxMetadataBytes = IMPORT_MAX_METADATA_BYTES,
  } = {}
) {
  if (!isImportSource(source)) throw new TypeError('source must be codex, claude or devin.');
  const reducer =
    source === 'codex' ? createCodexReducer() : source === 'claude' ? createClaudeReducer() : createDevinReducer();
  let records = 0;
  let malformed = 0;
  let tooLarge = false;
  let historyPartial = false;
  return {
    /** True while every message seen so far is a Claude sidechain message. */
    get sidechainOnly() {
      return reducer.sidechainOnly === true;
    },
    markTooLarge() {
      tooLarge = true;
    },
    /** A history base could not be followed in full. */
    markHistoryPartial() {
      historyPartial = true;
    },
    /** Feed a line for the stored title only (Claude Code's tail window); other sources ignore it. */
    pushTitleLine(raw) {
      let value;
      try {
        value = JSON.parse(String(raw).trim());
      } catch {
        return;
      }
      if (value && typeof value === 'object') reducer.pushTitle?.(value);
    },
    /** `inherited` lines belong to a history base followed ahead of this file's own lines. */
    pushLine(raw, { inherited = false } = {}) {
      if (tooLarge) return false;
      let line = String(raw);
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) return true;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        malformed += 1;
        return true;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        malformed += 1;
        return true;
      }
      records += 1;
      reducer.push(value, inherited);
      if (
        reducer.chars > maxTranscriptChars ||
        reducer.entries > maxRetainedEntries ||
        reducer.metadataBytes > maxMetadataBytes
      ) {
        tooLarge = true;
      }
      return !tooLarge;
    },
    result() {
      const parsed = reducer.result();
      const turns = normalizeTurns(parsed.rawTurns);
      // Joins and the user stub add text the reducer never counted.
      if (transcriptChars(turns) > maxTranscriptChars) tooLarge = true;
      const warnings = new Set(parsed.warnings);
      if (malformed) warnings.add(IMPORT_WARNING_MALFORMED);
      if (historyPartial) warnings.add(IMPORT_WARNING_HISTORY_PARTIAL);
      let errorCode = null;
      if (tooLarge) errorCode = IMPORT_ERROR_TOO_LARGE;
      else if (parsed.internalKind) errorCode = IMPORT_ERROR_INTERNAL;
      else if (!records) errorCode = malformed ? 'malformed' : 'empty';
      else if (!parsed.recognized) errorCode = 'unsupported';
      else if (!turns.length) errorCode = 'empty';
      return {
        source,
        errorCode,
        foreignSessionId: parsed.foreignSessionId,
        cwd: parsed.cwd,
        internalKind: parsed.internalKind,
        historyBase: parsed.historyBase ?? null,
        turns: tooLarge ? [] : turns,
        title: parsed.storedTitle || conversationTitle(turns),
        messageCount: tooLarge ? 0 : turns.length,
        warnings: [...warnings],
      };
    },
  };
}

/** Convert an in-memory JSONL body; `complete:false` drops a trailing partial line. */
export function convertConversationText(source, text, { complete = true, ...limits } = {}) {
  const converter = createConversationConverter(source, limits);
  let body = String(text ?? '');
  if (!complete) {
    const end = body.lastIndexOf('\n');
    body = end < 0 ? '' : body.slice(0, end);
  }
  let start = 0;
  while (start < body.length) {
    const newline = body.indexOf('\n', start);
    const end = newline < 0 ? body.length : newline;
    if (!converter.pushLine(body.slice(start, end))) break;
    start = end + 1;
  }
  return converter.result();
}
