import { patchSectionDigests } from '../renderer/renderer-logic.mjs';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { normalizeToolName } from '../../../../src/runtime/shared/tool-primitives.mjs';
import { outputFactsOf, REMOTE_OUTPUT_FACTS_FIELD } from '../renderer/tool-output-facts.mjs';
import { REMOTE_TRANSCRIPT_TAIL_BYTES } from './desktop-support';

// Provider replay material, not display data: `thinkingBlocks` are Anthropic's
// thinking/redacted_thinking blocks, kept so a later request can hand the model
// its own prior reasoning back verbatim. No renderer reads them, and in a long
// session they are a THIRD of the stored transcript — bytes a phone pays for on
// every join and can never show.
const REMOTE_TRANSCRIPT_DROP_FIELDS = ['thinkingBlocks', 'providerReplay'] as const;
/** A row's phone copy and its serialized size (UTF-8 bytes of its JSON). */
export interface RemoteTranscriptRow {
  row: unknown;
  bytes: number;
}
// One copy per row and role: a phone's window gives each row one role for as
// long as it holds it (remote-transcript-window.ts), so no row it holds is
// ever re-sent slimmer or fuller.
const projectedTranscriptItems = new WeakMap<object, { tail?: RemoteTranscriptRow; history?: RemoteTranscriptRow }>();

// Tool output is what a phone pays for. Measured on 39 real desktop sessions
// (3,465 tool rows, 51 MB restored): tool rows were 95% of the transcript
// bytes; `result` p90 4.8 KB / p99 18.5 KB and `rawResult` p90 8.6 KB /
// p99 31.7 KB (`rawResult` repeats `result` verbatim on 90% of rows). 8,192
// characters leaves 87% of rows untouched, so only the long tail is cut: 14%
// of all bytes with the output fields alone.
export const REMOTE_TOOL_OUTPUT_CAP_CHARS = 8_192;
const REMOTE_TOOL_OUTPUT_HEAD_CHARS = 6_144;
const REMOTE_TOOL_OUTPUT_TAIL_CHARS = REMOTE_TOOL_OUTPUT_CAP_CHARS - REMOTE_TOOL_OUTPUT_HEAD_CHARS;
const REMOTE_TOOL_OUTPUT_FIELDS = ['result', 'rawResult'] as const;
/** Rows a history page reveals above the rows a phone opened on (its window,
 *  remote-transcript-window.ts) reach it collapsed-sized: `rawResult` goes when it
 *  repeats `result` verbatim, and each output keeps its first lines, at most
 *  this many characters. `remoteOutputTruncated` stays on the row, so opening
 *  it (or the phone's idle prefetch) reads the whole text (`remoteToolOutput`). */
export const REMOTE_HISTORY_OUTPUT_CHARS = 600;
// The phone's 5-line preview (PREVIEW_OUTPUT_LINES); a command keeps one more,
// the line its open preview shows instead of a count.
const HISTORY_OUTPUT_LINES = 5;
const HISTORY_COMMAND_LINES = 6;
const HISTORY_COMMAND_TOOLS = new Set(['shell', 'bash', 'bash_session', 'shell_command']);
// Outputs whose open body is parsed from their text as a whole stay as they
// are (the output facts do not cover those parses): JSON and an ask_user
// answer (structured rows), a background task's status envelope, an agent's
// report, a task notification.
const HISTORY_WHOLE_OUTPUT =
  /^\s*(?:\{|\[\s*(?:[[{"\]\d-]|true|false|null)|background tasks?\b|agent task:|User (?:has answered|replied in chat))|task-notification>/i;
/** Set on a capped tool row: the length of its longest output before the cut. */
export const REMOTE_OUTPUT_TRUNCATED_FIELD = 'remoteOutputTruncated';
/** Set on a row whose `uiDiff` the phone's copy replaced with per-section digests. */
const REMOTE_DIFF_DIGEST_FIELD = 'uiDiffSummary';

/** Set on a row whose phone copy changed a text field, naming each field and
 *  how: `{ kind: 'omitted', at, omitted }` — the field holds its first `at`
 *  characters and its end, `omitted` characters were left out between them.
 *  The words are the phone's to write, in its own language. */
const REMOTE_OUTPUT_NOTES_FIELD = 'remoteOutputNotes';
export type RemoteOutputNote = { kind: 'omitted'; at: number; omitted: number };

/** The first and last characters of an output over the cap joined, and where
 *  and how much was cut between them. The cut is by length alone and never
 *  splits a surrogate pair; the end of a shell or build log is kept because
 *  that is where its exit status and errors are. */
function capToolOutput(text: string): { text: string; note: RemoteOutputNote } {
  let headEnd = REMOTE_TOOL_OUTPUT_HEAD_CHARS;
  const lastHead = text.charCodeAt(headEnd - 1);
  if (lastHead >= 0xd800 && lastHead <= 0xdbff) headEnd -= 1;
  let tailStart = text.length - REMOTE_TOOL_OUTPUT_TAIL_CHARS;
  const firstTail = text.charCodeAt(tailStart);
  if (firstTail >= 0xdc00 && firstTail <= 0xdfff) tailStart += 1;
  return {
    text: text.slice(0, headEnd) + text.slice(tailStart),
    note: { kind: 'omitted', at: headEnd, omitted: tailStart - headEnd },
  };
}

/** A history row's output cut to its first `lines` lines, at most
 *  REMOTE_HISTORY_OUTPUT_CHARS characters (never splitting a surrogate pair),
 *  and where the cut is; null when the output keeps its text (see
 *  HISTORY_WHOLE_OUTPUT) or already fits. */
function capHistoryOutput(text: string, lines: number): { text: string; note: RemoteOutputNote } | null {
  if (HISTORY_WHOLE_OUTPUT.test(text)) return null;
  let end = Math.min(text.length, REMOTE_HISTORY_OUTPUT_CHARS);
  let newline = -1;
  for (let line = 0; line < lines; line++) {
    newline = text.indexOf('\n', newline + 1);
    if (newline < 0) break;
  }
  if (newline >= 0) end = Math.min(end, newline);
  if (end >= text.length) return null;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), note: { kind: 'omitted', at: end, omitted: text.length - end } };
}

/** The output facts (`outputFactsOf`, the code the phone reads them with) the
 *  whole output gives and the cut copy's text does not, or null when the cut
 *  text gives them all. The facts are plain data, the same in any language. */
function wholeOutputFacts(whole: Record<string, unknown>, cut: Record<string, unknown>): object | null {
  const nowMs = Date.now();
  const before = outputFactsOf(whole, nowMs);
  const after = outputFactsOf(cut, nowMs);
  const changed = Object.entries(before).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(after[key]));
  return changed.length ? Object.fromEntries(changed) : null;
}

/** Whether a digest can stand in for `diff`: it is git-form, every section
 *  starting at a `diff --git` header. The renderer picks sections by header
 *  name (`patchForTarget`) and the session review joins patches at section
 *  starts, so such a diff reads the same per section as it does whole. A plain
 *  `---/+++` patch or one with leading text is sent whole. */
function isDigestibleDiff(diff: string): boolean {
  return /^diff --git /.test(diff);
}

/** `record` with its output fields capped, or `record` itself when none is over.
 *  A long edit diff is replaced by its digest (`uiDiffSummary`): what the
 *  transcript row and the turn review read from the diff, without the text. */
function cappedToolRecord(record: Record<string, unknown>, history = false): Record<string, unknown> {
  let capped: Record<string, unknown> | null = null;
  let longest = 0;
  const notes: Record<string, RemoteOutputNote> = {};
  const diff = record.uiDiff;
  if (typeof diff === 'string' && diff.length > REMOTE_TOOL_OUTPUT_CAP_CHARS && isDigestibleDiff(diff.trim())) {
    capped = { ...record };
    delete capped.uiDiff;
    capped[REMOTE_DIFF_DIGEST_FIELD] = { sections: patchSectionDigests(diff.trim()) };
  }
  // Only a verbatim string copy goes: a `rawResult` that differs from a cleaned
  // `result` is what the exit-marker and restored-notice readers need.
  const duplicateRaw = history && typeof record.rawResult === 'string' && record.rawResult === record.result;
  if (duplicateRaw) {
    capped ??= { ...record };
    delete capped.rawResult;
  }
  const lines =
    history && HISTORY_COMMAND_TOOLS.has(String(normalizeToolName(record.name ?? '')))
      ? HISTORY_COMMAND_LINES
      : HISTORY_OUTPUT_LINES;
  for (const field of REMOTE_TOOL_OUTPUT_FIELDS) {
    if (duplicateRaw && field === 'rawResult') continue;
    const value = record[field];
    if (typeof value !== 'string') continue;
    const head = history ? capHistoryOutput(value, lines) : null;
    if (head) {
      capped ??= { ...record };
      capped[field] = head.text;
      notes[field] = head.note;
      longest = Math.max(longest, value.length);
      continue;
    }
    if (value.length <= REMOTE_TOOL_OUTPUT_CAP_CHARS) continue;
    capped ??= { ...record };
    const cut = capToolOutput(value);
    capped[field] = cut.text;
    notes[field] = cut.note;
    longest = Math.max(longest, value.length);
  }
  if (capped && longest > 0) {
    capped[REMOTE_OUTPUT_TRUNCATED_FIELD] = longest;
    capped[REMOTE_OUTPUT_NOTES_FIELD] = notes;
    // An older row's header reads what the whole output gives, wherever its
    // cut text gives other (the newest rows keep the copy the desktop sends).
    const facts = history ? wholeOutputFacts(record, capped) : null;
    if (facts) capped[REMOTE_OUTPUT_FACTS_FIELD] = facts;
  }
  return capped ?? record;
}

/** A tool row (or an aggregate's members) with its outputs capped. */
function cappedToolItem(item: Record<string, unknown>, history: boolean): Record<string, unknown> {
  let capped = cappedToolRecord(item, history);
  if (!Array.isArray(item.toolMembers)) return capped;
  let changed = false;
  const members = item.toolMembers.map((member) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) return member;
    const next = cappedToolRecord(member as Record<string, unknown>, history);
    if (next !== member) changed = true;
    return next;
  });
  if (changed) capped = { ...capped, toolMembers: members };
  return capped;
}

/** The phone copy a tool row's outputs are cut to fit: a phone's whole first
 *  page (remote-transcript-window.ts). A message row is sent whole, over it or not. */
export const REMOTE_TRANSCRIPT_ROW_MAX_BYTES = REMOTE_TRANSCRIPT_TAIL_BYTES;

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null) ?? 'null', 'utf8');

/** `record` with each output field (REMOTE_TOOL_OUTPUT_FIELDS) longer than `cap`
 *  cut to its first `cap` characters (never splitting a surrogate pair), an
 *  `omitted` note at the cut (counting what an earlier cut already left out)
 *  and the whole length in `remoteOutputTruncated`; `record` when none is longer. */
function headCutRecord(record: Record<string, unknown>, cap: number): Record<string, unknown> {
  let cut: Record<string, unknown> | null = null;
  const prior = asRecord(record[REMOTE_OUTPUT_NOTES_FIELD]) ?? {};
  const notes: Record<string, unknown> = { ...prior };
  let longest = Number(record[REMOTE_OUTPUT_TRUNCATED_FIELD]) || 0;
  for (const field of REMOTE_TOOL_OUTPUT_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || value.length <= cap) continue;
    let end = cap;
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    const earlier = asRecord(prior[field]);
    const before = earlier?.kind === 'omitted' && Number.isInteger(earlier.omitted) ? Number(earlier.omitted) : 0;
    cut ??= { ...record };
    cut[field] = value.slice(0, end);
    notes[field] = { kind: 'omitted', at: end, omitted: value.length - end + before };
    longest = Math.max(longest, value.length + before);
  }
  if (!cut) return record;
  cut[REMOTE_OUTPUT_NOTES_FIELD] = notes;
  cut[REMOTE_OUTPUT_TRUNCATED_FIELD] = longest;
  return cut;
}

/** An oversized tool row's phone copy — one whose copy alone is over
 *  REMOTE_TRANSCRIPT_ROW_MAX_BYTES: the row and its aggregate members keep
 *  every field, their outputs cut to one shared head length, the longest that
 *  fits (`headCutRecord`: notes and `remoteOutputTruncated` say what was left
 *  out, and "Show full output" reads the whole outputs, `remoteToolOutput`).
 *  A row whose other fields alone are over the ceiling goes with empty heads,
 *  still over it. Message rows are never cut: their text has no way back. */
function oversizedRow(row: Record<string, unknown>): Record<string, unknown> {
  const cutAt = (cap: number): Record<string, unknown> => {
    const cut = headCutRecord(row, cap);
    if (!Array.isArray(row.toolMembers)) return cut;
    const members = row.toolMembers.map((member) => {
      const record = asRecord(member);
      return record ? headCutRecord(record, cap) : member;
    });
    return { ...cut, toolMembers: members };
  };
  let low = 0;
  let high = Math.max(
    0,
    ...[row, ...(Array.isArray(row.toolMembers) ? row.toolMembers : [])].flatMap((record) =>
      REMOTE_TOOL_OUTPUT_FIELDS.map((field) => {
        const value = asRecord(record)?.[field];
        return typeof value === 'string' ? value.length : 0;
      })
    )
  );
  while (low < high) {
    const cap = Math.ceil((low + high) / 2);
    if (serializedBytes(cutAt(cap)) <= REMOTE_TRANSCRIPT_ROW_MAX_BYTES) low = cap;
    else high = cap - 1;
  }
  return cutAt(low);
}

/** A row's phone copy as tail (`history` false: the rows a phone opened on and
 *  every later one) or as revealed history, and its serialized size. */
export function remoteTranscriptRow(item: unknown, history: boolean): RemoteTranscriptRow {
  if (!item || typeof item !== 'object') return { row: item, bytes: serializedBytes(item) };
  let cached = projectedTranscriptItems.get(item);
  if (!cached) {
    cached = {};
    projectedTranscriptItems.set(item, cached);
  }
  const role = history ? 'history' : 'tail';
  const hit = cached[role];
  if (hit) return hit;
  let projected: Record<string, unknown> | null = null;
  for (const field of REMOTE_TRANSCRIPT_DROP_FIELDS) {
    if (!Object.hasOwn(item, field)) continue;
    projected ??= { ...(item as Record<string, unknown>) };
    delete projected[field];
  }
  const base = projected ?? (item as Record<string, unknown>);
  let row = base.kind === 'tool' ? cappedToolItem(base, history) : base;
  let bytes = serializedBytes(row);
  if (base.kind === 'tool' && bytes > REMOTE_TRANSCRIPT_ROW_MAX_BYTES) {
    row = oversizedRow(row);
    bytes = serializedBytes(row);
  }
  const result = { row, bytes };
  cached[role] = result;
  return result;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** One tool row of a transcript by id: a top-level row, an aggregate's member
 *  by its own id, or by the `<aggregate id>:member:<index>` name the renderer
 *  gives an id-less member. */
export function findToolRecord(snapshot: unknown, itemId: string): Record<string, unknown> | null {
  const items = (snapshot as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const row = asRecord(item);
    if (row?.kind !== 'tool') continue;
    if (row.id != null && String(row.id) === itemId) return row;
    const members = Array.isArray(row.toolMembers) ? row.toolMembers.map(asRecord) : [];
    for (const [index, record] of members.entries()) {
      if (record && String(record.id ?? `${String(row.id ?? 'aggregate')}:member:${index}`) === itemId) return record;
    }
  }
  return null;
}

/** The uncapped output of one tool row. This is the other half of the cap:
 *  what the phone asks for when the user presses "Show full output". */
export function remoteToolOutput(
  snapshot: unknown,
  itemId: string
): { id: string; result?: unknown; rawResult?: unknown; uiDiff?: unknown } | null {
  const record = findToolRecord(snapshot, itemId);
  if (!record) return null;
  return {
    id: itemId,
    ...(Object.hasOwn(record, 'result') ? { result: record.result } : {}),
    ...(Object.hasOwn(record, 'rawResult') ? { rawResult: record.rawResult } : {}),
    ...(Object.hasOwn(record, 'uiDiff') ? { uiDiff: record.uiDiff } : {}),
  };
}

// `promptHistoryList` is the composer's Up-arrow recall: up to 50 whole
// prompts (PROMPT_HISTORY_LIMIT), merged across the Project's sessions, and it
// rides every session baseline. Pasted briefs made it the largest part of a
// phone boot — 1.19 MB of a 1.45 MB session frame for 50 prompts of ~24 KB —
// for a list a phone keyboard recalls only short prompts from. The phone's
// copy keeps the newest entries of at most ENTRY chars, within BUDGET chars
// (about 25 typed prompts of the ~1.3 KB the relay meter measured).
export const REMOTE_PROMPT_HISTORY_ENTRY_MAX_CHARS = 4_096;
export const REMOTE_PROMPT_HISTORY_BUDGET_CHARS = 32_768;
const projectedPromptHistories = new WeakMap<readonly unknown[], readonly unknown[]>();

/** The phone's Up-arrow history: `list` (newest first) without entries over
 *  the entry cap, cut where the budget runs out. The list itself when nothing
 *  is cut, and the same array for the same source, so the delta encoder's
 *  head patches keep comparing like with like. */
export function remotePromptHistory(list: readonly unknown[]): readonly unknown[] {
  const cached = projectedPromptHistories.get(list);
  if (cached) return cached;
  const kept: unknown[] = [];
  let chars = 0;
  for (const entry of list) {
    const length = typeof entry === 'string' ? entry.length : (JSON.stringify(entry ?? null)?.length ?? 0);
    if (length > REMOTE_PROMPT_HISTORY_ENTRY_MAX_CHARS) continue;
    if (chars + length > REMOTE_PROMPT_HISTORY_BUDGET_CHARS) break;
    chars += length;
    kept.push(entry);
  }
  const result = kept.length === list.length ? list : kept;
  projectedPromptHistories.set(list, result);
  return result;
}

/** Keep item identity and the host's full history page across both ordinary
 * deltas and recovery baselines; omit only provider-private replay material
 * and bound the prompt history (remotePromptHistory). Tool rows reach the
 * phone as the desktop shows them, their outputs capped only. The first
 * `historyEnd` rows are history a page revealed (remote-transcript-window.ts);
 * without one every row is sent as tail. */
export function remoteTranscriptSnapshot(snapshot: unknown, historyEnd = 0): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const record = snapshot as Record<string, unknown>;
  const history = Array.isArray(record.promptHistoryList)
    ? remotePromptHistory(record.promptHistoryList)
    : record.promptHistoryList;
  const historyCut = history !== record.promptHistoryList;
  let items = record.items;
  if (Array.isArray(record.items)) {
    let dropped = false;
    const projected = record.items.map((item, index) => {
      const next = remoteTranscriptRow(item, index < historyEnd).row;
      if (next !== item) dropped = true;
      return next;
    });
    if (dropped) items = projected;
  }
  if (items === record.items && !historyCut) return snapshot;
  return {
    ...record,
    ...(items !== record.items ? { items } : {}),
    ...(historyCut ? { promptHistoryList: history } : {}),
  };
}
