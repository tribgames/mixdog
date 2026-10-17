import { t } from './i18n';
import { findPatch, PATCH_CACHE_LIMIT } from './transcript-diff';
import type { TranscriptItem } from './desktop-types';
import { analyzePatchFiles, type parseUnifiedDiff } from './renderer-logic.mjs';
import { toolRowRevision, uiDiffDigest, type UiDiffSummary } from './transcript-tool-core';
import {
  buildSessionDiffRows,
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
import { classifyToolCategory, parseLineDelta, parseToolArgs, summarizeToolResult } from '../../../../src/runtime/shared/tool-surface.mjs';

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

/** Diffs in transcript order — text patches and the digests a phone's copy
 *  carries — summarized as one change. Each diff is analyzed on its own: joined
 *  as text, a plain `---/+++` patch after a `diff --git` one was read as the
 *  tail of that file's last hunk and its lines counted to the wrong file. */
export type TurnReviewDiffSegment = string | { row: TurnReviewRowRef; summary: UiDiffSummary };
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
      merged.additions += entry.additions;
      merged.deletions += entry.deletions;
      merged.lineStats ||= entry.lineStats;
      merged.status ||= entry.status;
      merged.binary ||= entry.binary;
      appendEntry(merged, entry);
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

/** Every successful patch-publishing tool call of the whole transcript (not
 *  just the current turn): the file set from their patches, the line totals
 *  from the same workload count the activity cards use. */
export function summarizeSessionTranscriptReview(items: TranscriptItem[], cwd = ''): TurnReviewSummary {
  const patches: TurnReviewDiffSegment[] = [];
  for (const item of items) {
    if (item?.kind !== 'tool') continue;
    // Grouped cards (`__aggregate__`) key their categories as
    // `Patch|Editing|Edited|file|files`, never a bare `Patch`.
    const patchCard =
      toolPublishesPatch(item) ||
      (item.aggregate === true && Object.keys(item.categories || {}).some((key) => key.startsWith('Patch|')));
    const written = !patchCard && !item.aggregate && String(item.name || '').toLowerCase() === 'write';
    if (!patchCard && !written) continue;
    const count = Math.max(1, Number(item.count || 1));
    if (item.isError === true || Number(item.errorCount || 0) >= count) continue;
    if (parseToolArgs(item.args)?.dry_run === true) continue;
    if (written) {
      // `write` publishes no diff: synthesize the added lines from its content
      // the way the card counts them (a new file is all additions).
      const args = parseToolArgs(item.args) || {};
      const target = String(args.file_path ?? args.filePath ?? args.path ?? '').replace(/\\/g, '/');
      const content = typeof args.content === 'string' ? args.content : '';
      if (!target || !content) continue;
      const lines = content.replace(/\n$/, '').split('\n');
      const created = /^\s*Created\b/.test(String(item.result ?? ''));
      patches.push(
        `diff --git a/${target} b/${target}\n${created ? 'new file mode 100644\n--- /dev/null\n' : `--- a/${target}\n`}+++ b/${target}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line: string) => `+${line}`).join('\n')}\n`
      );
      continue;
    }
    // `edit`-dialect calls carry no patch in their arguments; the runtime's
    // per-call `uiDiff` is the change they made. An explicit empty uiDiff means
    // the call changed nothing.
    const digest = uiDiffDigest(item);
    if (digest) {
      patches.push({ row: { id: String(item.id ?? ''), revision: toolRowRevision(item) }, summary: digest });
      continue;
    }
    const uiDiff = typeof item.uiDiff === 'string' ? item.uiDiff : null;
    const patch = uiDiff !== null ? uiDiff : findPatch(item);
    if (patch) patches.push(patch);
  }
  const summary = summarizeTurnReviewSegments(patches);
  // Tool patches sometimes carry ABSOLUTE paths; the session diff's rows are
  // project-relative, and the two sources must meet on the same key.
  const root = String(cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!root) return summary;
  const files: TurnReviewSummary['files'] = new Map();
  for (const [name, entry] of summary.files) {
    const normalized = name.replace(/\\/g, '/');
    const relative = normalized.toLowerCase().startsWith(`${root}/`) ? normalized.slice(root.length + 1) : name;
    const merged = files.get(relative);
    if (!merged) {
      files.set(relative, entry);
      continue;
    }
    merged.additions += entry.additions;
    merged.deletions += entry.deletions;
    merged.lineStats ||= entry.lineStats;
    merged.status ||= entry.status;
    merged.binary ||= entry.binary;
    appendEntry(merged, entry);
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

/** A transcript file the runtime diff lacks becomes a row, and a row takes the
 *  larger counts and the patch of the transcript's own edit, for a diff that
 *  is NOT the complete set (a runtime without ownership metadata): such a diff
 *  may only cover the running turn, so it never lowers the transcript's. */
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

/** THE session file list, shared by the pane, its title and the island.
 *  A `complete` runtime result is the net change set and is final: the
 *  transcript (historical activity, blind to Undo) never adds, drops or
 *  recounts a file — it only completes a row the runtime flagged `unmeasured`
 *  (an old record that kept no counts). Anything else falls back to the
 *  transcript-merged list the island always showed. */
export function resolveSessionRows(
  result: SessionDiffResult | null,
  items: TranscriptItem[],
  cwd = ''
): SessionDiffRow[] {
  const rows = buildSessionDiffRows(result);
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
