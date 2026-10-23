import { isAbsolute, resolve } from 'node:path';

import { patchSectionDigests } from '../renderer/renderer-logic.mjs';
import { DIFF_SECTION, diffSectionPaths, isSensitivePathSync } from './remote-sensitive-paths';

// Provider replay material, not display data: `thinkingBlocks` are Anthropic's
// thinking/redacted_thinking blocks, kept so a later request can hand the model
// its own prior reasoning back verbatim. No renderer reads them, and in a long
// session they are a THIRD of the stored transcript — bytes a phone pays for on
// every join and can never show.
const REMOTE_TRANSCRIPT_DROP_FIELDS = ['thinkingBlocks', 'providerReplay'] as const;
const projectedTranscriptItems = new WeakMap<object, { folder: string; result: object }>();

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
/** Set on a capped tool row: the length of its longest output before the cut. */
export const REMOTE_OUTPUT_TRUNCATED_FIELD = 'remoteOutputTruncated';
/** Set on a row whose `uiDiff` the phone's copy replaced with per-section digests. */
export const REMOTE_DIFF_DIGEST_FIELD = 'uiDiffSummary';

/** Set on a row whose phone copy changed a text field, naming each field and
 *  how: `{ kind: 'omitted', at, omitted }` — the field holds its first `at`
 *  characters and its end, `omitted` characters were left out between them —
 *  or `{ kind: 'withheld' }` — the field was emptied. The words for either are
 *  the phone's to write, in its own language. */
export const REMOTE_OUTPUT_NOTES_FIELD = 'remoteOutputNotes';
export type RemoteOutputNote = { kind: 'withheld' } | { kind: 'omitted'; at: number; omitted: number };

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
function cappedToolRecord(record: Record<string, unknown>): Record<string, unknown> {
  let capped: Record<string, unknown> | null = null;
  let longest = 0;
  const notes: Record<string, RemoteOutputNote> = {};
  const diff = record.uiDiff;
  if (typeof diff === 'string' && diff.length > REMOTE_TOOL_OUTPUT_CAP_CHARS && isDigestibleDiff(diff.trim())) {
    capped = { ...record };
    delete capped.uiDiff;
    capped[REMOTE_DIFF_DIGEST_FIELD] = { sections: patchSectionDigests(diff.trim()) };
  }
  for (const field of REMOTE_TOOL_OUTPUT_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || value.length <= REMOTE_TOOL_OUTPUT_CAP_CHARS) continue;
    capped ??= { ...record };
    const cut = capToolOutput(value);
    capped[field] = cut.text;
    notes[field] = cut.note;
    longest = Math.max(longest, value.length);
  }
  if (capped && longest > 0) {
    capped[REMOTE_OUTPUT_TRUNCATED_FIELD] = longest;
    capped[REMOTE_OUTPUT_NOTES_FIELD] = notes;
  }
  return capped ?? record;
}

/** A tool row (or an aggregate's members) with its outputs capped. */
function cappedToolItem(item: Record<string, unknown>): Record<string, unknown> {
  let capped = cappedToolRecord(item);
  if (!Array.isArray(item.toolMembers)) return capped;
  let changed = false;
  const members = item.toolMembers.map((member) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) return member;
    const next = cappedToolRecord(member as Record<string, unknown>);
    if (next !== member) changed = true;
    return next;
  });
  if (changed) capped = { ...capped, toolMembers: members };
  return capped;
}

function remoteTranscriptItem(item: unknown, folder: string): unknown {
  if (!item || typeof item !== 'object') return item;
  const cached = projectedTranscriptItems.get(item);
  if (cached?.folder === folder) return cached.result;
  let projected: Record<string, unknown> | null = null;
  for (const field of REMOTE_TRANSCRIPT_DROP_FIELDS) {
    if (!Object.hasOwn(item, field)) continue;
    projected ??= { ...(item as Record<string, unknown>) };
    delete projected[field];
  }
  const base = projected ?? (item as Record<string, unknown>);
  const result = base.kind === 'tool' ? remoteToolItem(base, folder) : base;
  projectedTranscriptItems.set(item, { folder, result });
  return result;
}

interface ToolRecordMatch {
  record: Record<string, unknown>;
  /** Rows that share this one's content: an aggregate's members, or a member's aggregate. */
  related: Record<string, unknown>[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** One tool row of a transcript by id: a top-level row, an aggregate's member
 *  by its own id, or by the `<aggregate id>:member:<index>` name the renderer
 *  gives an id-less member. */
export function findToolRecord(snapshot: unknown, itemId: string): ToolRecordMatch | null {
  const items = (snapshot as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const row = asRecord(item);
    if (row?.kind !== 'tool') continue;
    const members = Array.isArray(row.toolMembers) ? row.toolMembers.map(asRecord) : [];
    if (row.id != null && String(row.id) === itemId) {
      return { record: row, related: members.filter((member): member is Record<string, unknown> => member !== null) };
    }
    for (const [index, record] of members.entries()) {
      if (record && String(record.id ?? `${String(row.id ?? 'aggregate')}:member:${index}`) === itemId) {
        return { record, related: [row] };
      }
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
  const found = findToolRecord(snapshot, itemId);
  if (!found) return null;
  const { record } = found;
  return {
    id: itemId,
    ...(Object.hasOwn(record, 'result') ? { result: record.result } : {}),
    ...(Object.hasOwn(record, 'rawResult') ? { rawResult: record.rawResult } : {}),
    ...(Object.hasOwn(record, 'uiDiff') ? { uiDiff: record.uiDiff } : {}),
  };
}

const PATH_ARGUMENT_KEYS = new Set([
  'file_path',
  'filePath',
  'path',
  'file',
  'target',
  'cwd',
  'root',
  'paths',
  'files',
  'file_paths',
]);
const MAX_ARGUMENT_DEPTH = 8;

/** The paths tool rows name, and whether a diff header among them could not be
 *  read (which counts as naming a secret: it cannot be shown to be innocent). */
interface NamedPaths {
  paths: string[];
  /** The subset the tool call itself targets (its path arguments): the ones a
   *  tool opens, and so follows links through. Diff header names are not. */
  argumentPaths: string[];
  unreadable: boolean;
}

/** Every path the rows name: path arguments at any depth — a string, an array
 *  of them, or entries such as `reads: [{ path }]` under a path-list key — and
 *  the file names of their diff headers, quoted ones decoded by the same
 *  decoder the review lanes use. Plain data, no content is guessed at. */
export function toolRecordsNamedPaths(records: readonly Record<string, unknown>[]): NamedPaths {
  const paths = new Set<string>();
  const argumentPaths = new Set<string>();
  let unreadable = false;
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() && value !== '/dev/null') paths.add(value.trim());
  };
  const collect = (value: unknown, key: string, depth: number): void => {
    if (depth > MAX_ARGUMENT_DEPTH) return;
    if (typeof value === 'string') {
      if (PATH_ARGUMENT_KEYS.has(key)) {
        add(value);
        if (value.trim() && value !== '/dev/null') argumentPaths.add(value.trim());
      }
    } else if (Array.isArray(value)) {
      for (const entry of value) collect(entry, key, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [name, entry] of Object.entries(value)) collect(entry, name, depth + 1);
    }
  };
  for (const record of records) {
    let args: unknown = record.args;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    if (args && typeof args === 'object') collect(args, '', 0);
    if (typeof record.uiDiff === 'string') {
      const sections: string[][] = [[]];
      for (const line of record.uiDiff.split('\n')) {
        // A plain patch's `---`/`+++` names may carry a tab-separated timestamp.
        const text = line.replace(/^((?:---|\+\+\+) .*?)\t.*$/, '$1');
        if (DIFF_SECTION.test(text)) sections.push([text]);
        else sections[sections.length - 1].push(text);
      }
      for (const name of diffSectionPaths(['', ...sections[0]]) ?? []) add(name);
      for (const section of sections.slice(1)) {
        const names = diffSectionPaths(section);
        if (names) for (const name of names) add(name);
        else unreadable = true;
      }
    }
    const digest = asRecord(record.uiDiffSummary);
    if (Array.isArray(digest?.sections)) {
      for (const section of digest.sections) {
        const names = asRecord(section)?.names;
        if (Array.isArray(names)) for (const name of names) add(name);
      }
    }
  }
  return { paths: [...paths], argumentPaths: [...argumentPaths], unreadable };
}

/** The file paths a tool row names. */
export function toolRecordPaths(record: Record<string, unknown>): string[] {
  return toolRecordsNamedPaths([record]).paths;
}

/** Set on a row whose outputs the phone's copy emptied because the call
 *  touches a secret file (each emptied field is a `withheld` note). */
export const REMOTE_OUTPUT_WITHHELD_FIELD = 'remoteOutputWithheld';
const REMOTE_WITHHELD_TEXT_FIELDS = ['result', 'rawResult', 'liveOutput'] as const;

/** Whether any of `records` names a secret file, by its own name or through a
 *  link or junction (the same check the direct remote file reads apply). The
 *  snapshot is built synchronously, so the links are resolved with the cached,
 *  bounded lookup of isSensitivePathSync. */
function touchesSecretFile(records: readonly Record<string, unknown>[], folder: string): boolean {
  const { paths, argumentPaths, unreadable } = toolRecordsNamedPaths(records);
  if (unreadable) return true;
  // Relative paths are the session folder's, as the direct reads judge them.
  // With no folder known they cannot be told apart from a link, so the row is
  // withheld until the folder is known (the next update re-projects it).
  if (folder === '' && argumentPaths.some((path) => !isAbsolute(path))) return true;
  return (
    (folder !== '' && isSensitivePathSync(folder)) || paths.some((path) => isSensitivePathSync(resolve(folder, path)))
  );
}

/** `value` reduced to the path arguments it holds (same keys, at any depth);
 *  content-bearing arguments (`content`, `old_string`, patch bodies…) go. */
function pathOnlyArguments(value: unknown, key: string, depth: number): unknown {
  if (depth > MAX_ARGUMENT_DEPTH) return undefined;
  if (typeof value === 'string') return PATH_ARGUMENT_KEYS.has(key) ? value : undefined;
  if (Array.isArray(value)) {
    const kept = value.map((entry) => pathOnlyArguments(entry, key, depth + 1)).filter((entry) => entry !== undefined);
    return kept.length ? kept : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const kept: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    const reduced = pathOnlyArguments(entry, name, depth + 1);
    if (reduced !== undefined) kept[name] = reduced;
  }
  return Object.keys(kept).length ? kept : undefined;
}

/** `record` with every output it carries emptied (and noted as withheld) and
 *  its arguments reduced to the paths it names. */
function withheldToolRecord(record: Record<string, unknown>): Record<string, unknown> {
  const withheld = { ...record };
  if (Object.hasOwn(withheld, 'args')) {
    let args: unknown = withheld.args;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    withheld.args = pathOnlyArguments(args, '', 0) ?? {};
  }
  const notes: Record<string, RemoteOutputNote> = {};
  for (const field of REMOTE_WITHHELD_TEXT_FIELDS) {
    if (typeof withheld[field] !== 'string' || withheld[field] === '') continue;
    withheld[field] = '';
    notes[field] = { kind: 'withheld' };
  }
  withheld[REMOTE_OUTPUT_NOTES_FIELD] = notes;
  delete withheld.uiDiff;
  delete withheld.uiDiffSummary;
  delete withheld[REMOTE_OUTPUT_TRUNCATED_FIELD];
  withheld[REMOTE_OUTPUT_WITHHELD_FIELD] = true;
  return withheld;
}

/** A tool row (or an aggregate's members) as the phone may see it: outputs of
 *  anything that touches a secret file replaced, the rest capped. An aggregate
 *  row is withheld when any member is; a member when it or its aggregate is. */
function remoteToolItem(item: Record<string, unknown>, folder: string): Record<string, unknown> {
  const members = Array.isArray(item.toolMembers) ? item.toolMembers : [];
  const records = members.map(asRecord);
  const own = touchesSecretFile([item], folder);
  const denied = records.map((record) => own || (record !== null && touchesSecretFile([record], folder)));
  if (!own && !denied.some(Boolean)) return cappedToolItem(item);
  const row = withheldToolRecord(item);
  if (!Array.isArray(item.toolMembers)) return row;
  return {
    ...row,
    toolMembers: members.map((member, index) => {
      const record = records[index];
      if (!record) return member;
      return denied[index] ? withheldToolRecord(record) : cappedToolRecord(record);
    }),
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
 * and bound the prompt history (remotePromptHistory).
 * `sessionFolder` is where the session's relative paths lead from; absent, the
 * snapshot's own workspace is used, else the process folder. */
export function remoteTranscriptSnapshot(snapshot: unknown, sessionFolder = ''): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const record = snapshot as Record<string, unknown>;
  const history = Array.isArray(record.promptHistoryList)
    ? remotePromptHistory(record.promptHistoryList)
    : record.promptHistoryList;
  const historyCut = history !== record.promptHistoryList;
  let items = record.items;
  if (Array.isArray(record.items)) {
    const workspaceCwd = asRecord(record.workspace)?.cwd;
    const folder = sessionFolder || (typeof workspaceCwd === 'string' ? workspaceCwd : '');
    let dropped = false;
    const projected = record.items.map((item) => {
      const next = remoteTranscriptItem(item, folder);
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
