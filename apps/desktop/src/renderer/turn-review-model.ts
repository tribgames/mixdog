import { t } from './i18n';
import { findPatch, PATCH_CACHE_LIMIT } from './transcript-diff';
import type { TranscriptItem } from './desktop-types';
import { carriedSum, placedHash, textHash } from './list-carry';
import { analyzePatchFiles, type parseUnifiedDiff } from './renderer-logic.mjs';
import { toolRowRevision, uiDiffDigest, type UiDiffSummary } from './transcript-tool-core';
import {
  sessionDiffRowsOf,
  isAbsolutePath,
  PATCH_TOO_LARGE,
  sessionDiffFileOmitted,
  type SessionDiffResult,
  type SessionDiffRow,
} from './session-diff-model';
import { RendererLruCache } from './renderer-lru-cache';
import { registerIdleReclaim } from './idle-reclaim';
import {
  agentReviewCache,
  leadReviewCache,
  leadReviewFilesCache,
  leadReviewSnapshotKindCache,
  leadReviewCheckpointIdCache,
  leadReviewHistoryTurnsCache,
  type AgentTurnReview,
  type TurnReviewFile,
} from './turn-review-cache';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory, parseLineDelta, parseToolArgs, summarizeToolResult } from '../../../../packages/protocol-client/src/rows/tool-surface.mjs';

// "Review Changes": the headline is one authoritative turn-start → current
// worktree diff. Exact worker apply_patch diffs remain attribution metadata and
// are only added to totals in the non-Git fallback.
type TurnReviewPatchPart = ReturnType<typeof parseUnifiedDiff>[number];
export type TurnReviewFileEntry = {
  additions: number;
  deletions: number;
  lineStats: boolean;
  status: string;
  binary: boolean;
  parts: ReturnType<typeof parseUnifiedDiff>;
  /** The contributions to `parts` in transcript order, when a phone holds
   *  the digest of one instead of its text: an index into `parts`, or the
   *  row whose diff the host still has. Absent when every diff is held. */
  slots?: Array<number | TurnReviewRowRef>;
};
/** A transcript row (and the revision of it) a digest-derived file came from. */
export type TurnReviewRowRef = { id: string; revision: string };
export type TurnReviewSummary = {
  files: Map<string, TurnReviewFileEntry>;
  additions: number;
  deletions: number;
  hasLineStats: boolean;
};
const TURN_REVIEW_PATCH_CACHE_MAX_CHARS = 4 * 1024 * 1024;
const TURN_REVIEW_PATCH_CACHE_ENTRY_MAX_CHARS = 512 * 1024;
const turnReviewPatchCache = new RendererLruCache<
  string,
  Array<{
    name: string;
    additions: number;
    deletions: number;
    lineStats: boolean;
    status: string;
    binary: boolean;
    part: TurnReviewPatchPart;
  }>
>({
  name: 'turn-review-parsed',
  maxEntries: PATCH_CACHE_LIMIT,
  maxChars: TURN_REVIEW_PATCH_CACHE_MAX_CHARS,
  measure: (value, patch) => patch.length + JSON.stringify(value).length,
});
registerIdleReclaim(() => {
  turnReviewPatchCache.clear();
});

function analyzeTurnReviewPatch(patch: string) {
  const cached = turnReviewPatchCache.get(patch);
  if (cached) {
    return cached;
  }
  // A bare `diff --git` header is not a file change (it used to render a
  // misleading “+0 -0” row); analyzePatchFiles drops it.
  const analyzed = analyzePatchFiles(patch);
  if (patch.length <= TURN_REVIEW_PATCH_CACHE_ENTRY_MAX_CHARS) {
    turnReviewPatchCache.set(patch, analyzed);
  }
  return analyzed;
}

const partIndexes = (entry: TurnReviewFileEntry): number[] => entry.parts.map((_, index) => index);

/** `source` appended to `target`: its parts, and the order they and any
 *  digest rows came in. */
function appendEntry(target: TurnReviewFileEntry, source: TurnReviewFileEntry): void {
  const offset = target.parts.length;
  const own = target.slots ?? partIndexes(target);
  const added = (source.slots ?? partIndexes(source)).map((slot) => (typeof slot === 'number' ? slot + offset : slot));
  target.parts.push(...source.parts);
  if (target.slots || source.slots) target.slots = [...own, ...added];
}

type AnalyzedFile = Omit<ReturnType<typeof analyzePatchFiles>[number], 'part'> & {
  part?: TurnReviewPatchPart;
  row?: TurnReviewRowRef;
};

/** The files of analyzed diffs, one entry per name. A file that came from a
 *  digest has no parsed part: its diff text is not held. */
function summarizeAnalyzed(list: readonly AnalyzedFile[]): TurnReviewSummary {
  const files: TurnReviewSummary['files'] = new Map();
  for (const analyzed of list) {
    const entry = files.get(analyzed.name) || {
      additions: 0,
      deletions: 0,
      lineStats: false,
      status: '',
      binary: false,
      parts: [],
    };
    entry.additions += analyzed.additions;
    entry.deletions += analyzed.deletions;
    entry.lineStats ||= analyzed.lineStats;
    entry.status ||= analyzed.status;
    entry.binary ||= analyzed.binary;
    if (analyzed.part) {
      entry.parts.push(analyzed.part);
      entry.slots?.push(entry.parts.length - 1);
    }
    if (analyzed.row) {
      entry.slots ??= partIndexes(entry);
      const last = entry.slots.at(-1);
      // One row's sections for a file are one contribution.
      if (typeof last !== 'object' || last.id !== analyzed.row.id) entry.slots.push(analyzed.row);
    }
    files.set(analyzed.name, entry);
  }
  return turnReviewSummaryOf(files);
}

export function summarizeTurnReviewPatch(patch: string): TurnReviewSummary {
  if (!patch) return turnReviewSummaryOf(new Map());
  try {
    return summarizeAnalyzed(analyzeTurnReviewPatch(patch));
  } catch {
    /* malformed/non-diff payload — skip */
    return turnReviewSummaryOf(new Map());
  }
}

export type TurnReviewDiffSegment = string | { row: TurnReviewRowRef; summary: UiDiffSummary };
/** Diffs in transcript order, summarized as one change. Each is analyzed on its
 *  own: joined as text, a plain `---/+++` patch after a `diff --git` one counts
 *  to the wrong file. */
export function summarizeTurnReviewSegments(segments: readonly TurnReviewDiffSegment[]): TurnReviewSummary {
  const analyzed: AnalyzedFile[] = [];
  for (const segment of segments) {
    if (typeof segment !== 'string') {
      analyzed.push(
        ...segment.summary.sections.flatMap((section) => section.files.map((file) => ({ ...file, row: segment.row })))
      );
      continue;
    }
    try {
      analyzed.push(...analyzeTurnReviewPatch(segment));
    } catch {
      /* malformed/non-diff payload — skip */
    }
  }
  return summarizeAnalyzed(analyzed);
}

/** Totals a summary always carries for its own file map. */
function turnReviewSummaryOf(files: Map<string, TurnReviewFileEntry>): TurnReviewSummary {
  let additions = 0;
  let deletions = 0;
  let hasLineStats = false;
  for (const entry of files.values()) {
    additions += entry.additions;
    deletions += entry.deletions;
    hasLineStats ||= entry.lineStats;
  }
  return { files, additions, deletions, hasLineStats };
}

export function summarizeAuthoritativeTurnReview(filesInput: TurnReviewFile[], patch: string): TurnReviewSummary {
  const parsed = summarizeTurnReviewPatch(patch);
  const files: TurnReviewSummary['files'] = new Map();
  for (const row of filesInput) {
    const name = String(row?.path || '');
    if (!name) continue;
    const parsedEntry = parsed.files.get(name) || (row.oldPath ? parsed.files.get(String(row.oldPath)) : undefined);
    const additions = typeof row.additions === 'number' ? row.additions : 0;
    const deletions = typeof row.deletions === 'number' ? row.deletions : 0;
    files.set(name, {
      additions,
      deletions,
      lineStats: additions + deletions > 0,
      status: String(row.status || parsedEntry?.status || 'M'),
      binary: row.binary === true || parsedEntry?.binary === true,
      parts: parsedEntry?.parts || [],
    });
  }
  return turnReviewSummaryOf(files);
}

function foldEntry(target: TurnReviewFileEntry, entry: TurnReviewFileEntry): void {
  target.additions += entry.additions;
  target.deletions += entry.deletions;
  target.lineStats ||= entry.lineStats;
  target.status ||= entry.status;
  target.binary ||= entry.binary;
  appendEntry(target, entry);
}

export function mergeTurnReviewSummaries(summaries: TurnReviewSummary[]): TurnReviewSummary {
  const files: TurnReviewSummary['files'] = new Map();
  let additions = 0;
  let deletions = 0;
  for (const summary of summaries) {
    additions += summary.additions;
    deletions += summary.deletions;
    for (const [name, entry] of summary.files) {
      const merged = files.get(name) || {
        additions: 0,
        deletions: 0,
        lineStats: false,
        status: '',
        binary: false,
        parts: [],
      };
      foldEntry(merged, entry);
      files.set(name, merged);
    }
  }
  return {
    files,
    additions,
    deletions,
    hasLineStats: summaries.some((summary) => summary.hasLineStats),
  };
}

export function statusLabel(entry: TurnReviewFileEntry): string {
  if (entry.binary) return t('Binary');
  if (entry.status === 'R') return t('Renamed');
  if (entry.status === 'C') return t('Copied');
  if (entry.status === 'A') return t('Added');
  if (entry.status === 'D') return t('Deleted');
  if (entry.status === 'T') return t('Metadata');
  return t('Changed');
}

/** The review state the shared cache holds for one turn scope. */
export function cachedTurnReviewState(scopeKey: string) {
  return {
    scopeKey,
    reviews: agentReviewCache.get(scopeKey) || [],
    leadPatch: leadReviewCache.get(scopeKey) ?? null,
    files: leadReviewFilesCache.get(scopeKey) || [],
    snapshotKind: leadReviewSnapshotKindCache.get(scopeKey) || '',
    checkpointId: leadReviewCheckpointIdCache.get(scopeKey) || '',
    historyTurns: leadReviewHistoryTurnsCache.get(scopeKey) || 0,
  };
}

export function statusCode(entry: TurnReviewFileEntry): string {
  const status = String(entry.status || '').toUpperCase();
  if (['A', 'D', 'M', 'R', 'C', 'T'].includes(status)) return status;
  if (entry.binary) return 'B';
  return entry.lineStats ? 'M' : '';
}

// Single-quoted so the capability-inventory source scan counts this surface.
export const TURN_REVIEW_CAPABILITY = 'getTurnReviewDiff';

export function toolPublishesPatch(item: TranscriptItem): boolean {
  const categories = item.categories;
  if (categories && typeof categories === 'object' && Object.hasOwn(categories, 'Patch')) return true;
  return classifyToolCategory(String(item.name || ''), item.args) === 'Patch';
}

const READ_ONLY_CATEGORIES = new Set([
  'Read',
  'Search',
  'Load',
  'Skill',
  'Web Research',
  'Memory',
  'Explore',
  'Setup',
  'Browser',
]);

function toolMayChangeFiles(item: TranscriptItem): boolean {
  const keys = item.categories && typeof item.categories === 'object' ? Object.keys(item.categories) : [];
  // A grouped card keys its categories as `Patch|Editing|Edited|file|files`.
  const categories = keys.length
    ? keys.map((key) => key.split('|')[0])
    : [classifyToolCategory(String(item.name || ''), item.args)];
  return categories.some((category) => !READ_ONLY_CATEGORIES.has(category));
}

/** What can change the worktree's review within a transcript: a finished
 *  call of a tool that may write files, and a turn's end. Text, reasoning,
 *  read-only tools, running tools and sub-agent progress leave it alone. The
 *  key is of which calls finished and which turns ended, not of their order:
 *  the same ones in another order finished nothing new. */
export function fileChangeKey(items: readonly TranscriptItem[] | undefined): string {
  if (!Array.isArray(items)) return '';
  const { count, sum } = fileChanges(items as readonly TranscriptItem[]);
  return `${count}:${(sum >>> 0).toString(36)}`;
}

/** What an item with an id says of the worktree (null: nothing), read once per item object. */
const fileChangeStates = new WeakMap<TranscriptItem, number | null>();
/** Summed per list, and carried on from the list a frame made it from: a frame's unchanged items are not read again. */
const fileChanges = carriedSum((item: TranscriptItem, index: number) => {
  const known = item ? fileChangeStates.get(item) : undefined;
  if (known !== undefined) return known ?? undefined;
  let state: string | null = null;
  if (item?.kind === 'turndone' || item?.kind === 'statusdone') state = `e${item.id ?? index}`;
  else if (item?.kind === 'tool' && toolMayChangeFiles(item)) {
    const status = String(item.status || '');
    const done =
      item.completedAt || item.completedCount || item.result !== undefined || (status !== '' && status !== 'running');
    if (!item.streaming && status !== 'running' && done) {
      state = `t${item.id ?? index}:${item.completedAt ?? item.completedCount ?? ''}`;
    }
  }
  const hash = state === null ? null : textHash(state);
  // A row without an id is told apart by its place, which another list may not give it.
  if (item && item.id !== undefined && item.id !== null) fileChangeStates.set(item, hash);
  return hash ?? undefined;
});

export function summarizeTurnReviewOperations(items: TranscriptItem[], turnStart: number) {
  let additions = 0;
  let deletions = 0;
  for (let index = turnStart + 1; index < items.length; index++) {
    const item = items[index];
    if (item?.kind !== 'tool' || !toolPublishesPatch(item)) continue;
    const count = Math.max(1, Number(item.count || 1));
    if (item.isError === true || Number(item.errorCount || 0) >= count) continue;
    if (parseToolArgs(item.args)?.dry_run === true) continue;
    const result = item.result ?? item.rawResult ?? '';
    const summaryText = item.aggregate
      ? String(result)
      : summarizeToolResult(String(item.name || ''), item.args, String(result), false) || '';
    const delta = parseLineDelta(summaryText);
    if (delta.seen) {
      additions += delta.added;
      deletions += delta.removed;
      continue;
    }
    const patch = findPatch(item);
    if (!patch) continue;
    try {
      for (const analyzed of analyzeTurnReviewPatch(patch)) {
        additions += analyzed.additions;
        deletions += analyzed.deletions;
      }
    } catch {
      /* malformed/non-diff payload — skip */
    }
  }
  return {
    additions,
    deletions,
    hasLineStats: additions + deletions > 0,
  };
}

/** A `write` call publishes no diff: its content counted as added lines, as the
 *  activity card counts them. */
function writeToolPatch(item: TranscriptItem): string | null {
  const args = parseToolArgs(item.args) || {};
  const target = String(args.file_path ?? args.filePath ?? args.path ?? '').replace(/\\/g, '/');
  const content = typeof args.content === 'string' ? args.content : '';
  if (!target || !content) return null;
  const lines = content.replace(/\n$/, '').split('\n');
  const created = /^\s*Created\b/.test(String(item.result ?? ''));
  return `diff --git a/${target} b/${target}\n${created ? 'new file mode 100644\n--- /dev/null\n' : `--- a/${target}\n`}+++ b/${target}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line: string) => `+${line}`).join('\n')}\n`;
}

/** How a tool item's diff is read for the session's review: its patch card, a `write` call's content, or not at all. */
function diffSource(item: TranscriptItem | undefined): 'patch' | 'written' | null {
  if (item?.kind !== 'tool') return null;
  const patchCard =
    toolPublishesPatch(item) ||
    (item.aggregate === true && Object.keys(item.categories || {}).some((key) => key.startsWith('Patch|')));
  const written = !patchCard && !item.aggregate && String(item.name || '').toLowerCase() === 'write';
  if (!patchCard && !written) return null;
  const count = Math.max(1, Number(item.count || 1));
  if (item.isError === true || Number(item.errorCount || 0) >= count) return null;
  if (parseToolArgs(item.args)?.dry_run === true) return null;
  return written ? 'written' : 'patch';
}

/** A number of its own for each item a session's review reads a diff from (null: it reads none), by the item. */
const diffItems = new WeakMap<TranscriptItem, number | null>();
/** Those numbers summed per list, each with its place, carried on from the list a frame made it from. */
const diffItemsOf = carriedSum((item: TranscriptItem, index: number) => {
  let own = item ? diffItems.get(item) : undefined;
  if (own === undefined) {
    own = diffSource(item) === null ? null : (Math.random() * 0x100000000) | 0;
    if (item) diffItems.set(item, own);
  }
  return own === null ? undefined : placedHash(own, index);
});

/** Stands for the items `summarizeSessionTranscriptReview` reads (`diffSource`: the tool calls that publish a patch and
 *  the `write` calls, less the failed and the dry runs) and their places: the same for two lists that hold the same ones
 *  in the same places, so a frame that changed and moved none of them leaves the review as it was. */
export function transcriptReviewKey(items: readonly TranscriptItem[]): string {
  const { count, sum } = diffItemsOf(items);
  return `${count}:${sum}`;
}

function transcriptDiffSegments(items: TranscriptItem[]): TurnReviewDiffSegment[] {
  const segments: TurnReviewDiffSegment[] = [];
  for (const item of items) {
    const source = diffSource(item);
    if (source === null) continue;
    if (source === 'written') {
      const patch = writeToolPatch(item);
      if (patch) segments.push(patch);
      continue;
    }
    const digest = uiDiffDigest(item);
    if (digest) {
      const id = typeof item.uiDiffMemberId === 'string' ? item.uiDiffMemberId : String(item.id ?? '');
      segments.push({ row: { id, revision: toolRowRevision(item) }, summary: digest });
      continue;
    }
    const uiDiff = typeof item.uiDiff === 'string' ? item.uiDiff : null;
    const patch = uiDiff !== null ? uiDiff : findPatch(item);
    if (patch) segments.push(patch);
  }
  return segments;
}

/** The project-relative form of a diff file name: the folder is compared
 *  case-insensitively and the name kept as written; names outside it stay as
 *  given. */
export function reviewKey(rawName: string, cwd: string): string {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const normalized = rawName.replace(/\\/g, '/');
  return root && normalized.toLowerCase().startsWith(`${root}/`) ? normalized.slice(root.length + 1) : rawName;
}

/** Every successful patch-publishing tool call of the whole transcript, not
 *  just the current turn. */
export function summarizeSessionTranscriptReview(items: TranscriptItem[], cwd = ''): TurnReviewSummary {
  const summary = summarizeTurnReviewSegments(transcriptDiffSegments(items));
  if (!cwd) return summary;
  const files: TurnReviewSummary['files'] = new Map();
  for (const [name, entry] of summary.files) {
    const relative = reviewKey(name, cwd);
    const merged = files.get(relative);
    if (merged) foldEntry(merged, entry);
    else files.set(relative, entry);
  }
  return turnReviewSummaryOf(files);
}

/** The session diff pane's rows (the runtime's session-wide, session-owned
 *  paths) as a review summary. */
export function summarizeSessionDiffRows(rows: readonly SessionDiffRow[]): TurnReviewSummary {
  const files: TurnReviewSummary['files'] = new Map();
  for (const row of rows) {
    files.set(row.path, {
      additions: row.additions,
      deletions: row.deletions,
      lineStats: row.additions + row.deletions > 0,
      status: row.status,
      binary: row.binary,
      parts: row.parts,
    });
  }
  return turnReviewSummaryOf(files);
}

function mergeTranscriptIntoRows(rows: readonly SessionDiffRow[], transcript: TurnReviewSummary): SessionDiffRow[] {
  const known = new Set(rows.map((row) => row.path));
  const merged = rows.map((row) => {
    const entry = transcript.files.get(row.path);
    if (!entry) return row;
    const additions = Math.max(row.additions, entry.additions);
    const deletions = Math.max(row.deletions, entry.deletions);
    const useParts = row.parts.length === 0 && entry.parts.length > 0;
    return {
      ...row,
      additions,
      deletions,
      parts: useParts ? entry.parts : row.parts,
      reason: useParts ? '' : row.reason,
    };
  });
  for (const [path, entry] of transcript.files) {
    if (known.has(path)) continue;
    merged.push({
      id: path,
      path,
      outside: isAbsolutePath(path),
      oldPath: '',
      status: statusCode(entry) || 'M',
      additions: entry.additions,
      deletions: entry.deletions,
      binary: entry.binary,
      reason: '',
      unmeasured: false,
      parts: entry.parts,
    });
  }
  return merged;
}

/** The session file list shared by the pane, its title and the island. A
 *  `complete` runtime result is final: the transcript only completes rows
 *  flagged `unmeasured`. Anything else merges the transcript in. */
export function resolveSessionRows(
  result: SessionDiffResult | null,
  items: TranscriptItem[],
  cwd = ''
): SessionDiffRow[] {
  // The read parsed it (a file per task); this only looks it up.
  const rows = sessionDiffRowsOf(result);
  if (result?.supported === false || result?.authoritative !== true) return rows;
  const transcript = summarizeSessionTranscriptReview(items, cwd);
  if (result.complete !== true) return mergeTranscriptIntoRows(rows, transcript);
  return rows.map((row) => {
    const entry = row.unmeasured ? transcript.files.get(row.path) : undefined;
    if (!entry) return row;
    return {
      ...row,
      additions: entry.additions,
      deletions: entry.deletions,
      parts: entry.parts,
      reason: entry.parts.length > 0 ? '' : row.reason,
      unmeasured: false,
    };
  });
}
export type TurnReviewCapabilityValue = {
  /** The review is exactly the one tagged `etag` the bar already holds. */
  unchanged?: boolean;
  etag?: unknown;
  supported?: boolean;
  authoritative?: boolean;
  snapshotKind?: unknown;
  revertMode?: unknown;
  checkpointId?: unknown;
  /** `recorded`: rebuilt from the session's durable turn record against the
   *  current worktree, so a refreshing re-read answers the same. */
  reason?: unknown;
  patch?: unknown;
  /** Retained turn change records that Delete history removes. */
  historyTurns?: unknown;
  /** No file's patch fit the reply: the files and counts are still listed. */
  diffTooLarge?: unknown;
  files?: Array<{
    path?: unknown;
    oldPath?: unknown;
    status?: unknown;
    additions?: unknown;
    deletions?: unknown;
    binary?: unknown;
    patchOmitted?: unknown;
    reason?: unknown;
  }>;
  agents?: Array<{
    sessionId?: unknown;
    agent?: unknown;
    tag?: unknown;
    patch?: unknown;
  }>;
} | null;

/** Narrowing of the turn-review capability reply. Everything the bar trusts
 *  passes through here, so an unsupported or malformed reply (null) can never
 *  reach state or the shared cache. */
export function decodeTurnReviewCapabilityValue(value: TurnReviewCapabilityValue): {
  leadPatch: string | null;
  snapshotKind: string;
  checkpointId: string;
  files: TurnReviewFile[];
  reviews: AgentTurnReview[];
  historyTurns: number;
  diffTooLarge: boolean;
} | null {
  if (!value || value.supported === false) return null;
  const authoritative = value.authoritative === true;
  const patchText = typeof value.patch === 'string' ? value.patch : '';
  const leadPatch = authoritative ? patchText : null;
  const snapshotKind = authoritative ? String(value.snapshotKind || '') : '';
  const checkpointId = authoritative ? String(value.checkpointId || '') : '';
  const files = (authoritative && Array.isArray(value.files) ? value.files : []).flatMap((row) => {
    const path = String(row?.path || '');
    if (!path) return [];
    return [
      {
        path,
        oldPath: row?.oldPath ? String(row.oldPath) : null,
        status: row?.status ? String(row.status) : 'M',
        additions: typeof row?.additions === 'number' ? row.additions : null,
        deletions: typeof row?.deletions === 'number' ? row.deletions : null,
        binary: row?.binary === true,
        ...(sessionDiffFileOmitted(row) ? { patchOmitted: true, reason: PATCH_TOO_LARGE } : {}),
      },
    ];
  });
  const reviews = (Array.isArray(value.agents) ? value.agents : []).flatMap((review) => {
    const childSessionId = String(review?.sessionId || '');
    const patch = typeof review?.patch === 'string' ? review.patch : '';
    if (!childSessionId || !patch) return [];
    return [
      {
        sessionId: childSessionId,
        agent: review?.agent ? String(review.agent) : null,
        tag: review?.tag ? String(review.tag) : null,
        patch,
      },
    ];
  });
  const historyTurns = typeof value.historyTurns === 'number' ? Math.max(0, value.historyTurns) : 0;
  const diffTooLarge = authoritative && value.diffTooLarge === true;
  return { leadPatch, snapshotKind, checkpointId, files, reviews, historyTurns, diffTooLarge };
}
