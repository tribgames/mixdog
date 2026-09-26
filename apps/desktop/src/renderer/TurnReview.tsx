import { Check, FileDiff, FileText, Undo2, X } from 'lucide-react';
import {
  type Dispatch,
  memo,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { t } from './i18n';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { GitDiffBody } from './ReviewPane';
import { findPatch, PATCH_CACHE_LIMIT } from './TranscriptView';
import { readDiffStyle, TURN_REVIEW_DIFF_STYLE_KEY, type TranscriptItem, writeDiffStyle } from './desktop-types';
import { reviewScopePending } from './composer-dock-reservation';
import { parseUnifiedDiff, turnReviewScope } from './renderer-logic.mjs';
import { RendererLruCache } from './renderer-lru-cache';
import { registerIdleReclaim } from './idle-reclaim';
import {
  agentReviewCache,
  leadReviewCache,
  leadReviewFilesCache,
  leadReviewSnapshotKindCache,
  leadReviewCheckpointIdCache,
  rememberAgentReviews,
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
type TurnReviewFileEntry = {
  additions: number;
  deletions: number;
  lineStats: boolean;
  status: string;
  binary: boolean;
  parts: ReturnType<typeof parseUnifiedDiff>;
};
type TurnReviewSummary = {
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
  const analyzed = parseUnifiedDiff(patch).flatMap((part) => {
    const name = String(part.newFile?.fileName || '');
    if (!name) return [];
    let additions = 0;
    let deletions = 0;
    for (const line of part.hunks.join('\n').split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
    const status = String(part.status || '');
    // A bare `diff --git` header is not a file change. It used to survive as
    // an empty parsed part and rendered the misleading “+0 -0” row.
    if (additions === 0 && deletions === 0 && !status) return [];
    return [
      {
        name,
        additions,
        deletions,
        lineStats: additions + deletions > 0,
        status,
        binary: status === 'binary',
        part,
      },
    ];
  });
  if (patch.length <= TURN_REVIEW_PATCH_CACHE_ENTRY_MAX_CHARS) {
    turnReviewPatchCache.set(patch, analyzed);
  }
  return analyzed;
}

function summarizeTurnReviewPatch(patch: string): TurnReviewSummary {
  const files: TurnReviewSummary['files'] = new Map();
  if (patch) {
    try {
      for (const analyzed of analyzeTurnReviewPatch(patch)) {
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
        entry.parts.push(analyzed.part);
        files.set(analyzed.name, entry);
      }
    } catch {
      /* malformed/non-diff payload — skip */
    }
  }
  return turnReviewSummaryOf(files);
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

function summarizeAuthoritativeTurnReview(filesInput: TurnReviewFile[], patch: string): TurnReviewSummary {
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

function mergeTurnReviewSummaries(summaries: TurnReviewSummary[]): TurnReviewSummary {
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
      merged.parts.push(...entry.parts);
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

function statusLabel(entry: TurnReviewFileEntry): string {
  if (entry.binary) return t('Binary');
  if (entry.status === 'R') return t('Renamed');
  if (entry.status === 'C') return t('Copied');
  if (entry.status === 'A') return t('Added');
  if (entry.status === 'D') return t('Deleted');
  if (entry.status === 'T') return t('Metadata');
  return t('Changed');
}

/** The review state the shared cache holds for one turn scope. */
function cachedTurnReviewState(scopeKey: string) {
  return {
    scopeKey,
    reviews: agentReviewCache.get(scopeKey) || [],
    leadPatch: leadReviewCache.get(scopeKey) ?? null,
    files: leadReviewFilesCache.get(scopeKey) || [],
    snapshotKind: leadReviewSnapshotKindCache.get(scopeKey) || '',
    checkpointId: leadReviewCheckpointIdCache.get(scopeKey) || '',
  };
}

function statusCode(entry: TurnReviewFileEntry): string {
  const status = String(entry.status || '').toUpperCase();
  if (['A', 'D', 'M', 'R', 'C', 'T'].includes(status)) return status;
  if (entry.binary) return 'B';
  return entry.lineStats ? 'M' : '';
}

// Single-quoted so the capability-inventory source scan counts this surface.
const TURN_REVIEW_CAPABILITY = 'getTurnReviewDiff';

function toolPublishesPatch(item: TranscriptItem): boolean {
  const categories = item.categories;
  if (categories && typeof categories === 'object' && Object.hasOwn(categories, 'Patch')) return true;
  return classifyToolCategory(String(item.name || ''), item.args) === 'Patch';
}

function summarizeTurnReviewOperations(items: TranscriptItem[], turnStart: number) {
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

type TurnReviewCapabilityValue = {
  supported?: boolean;
  authoritative?: boolean;
  snapshotKind?: unknown;
  revertMode?: unknown;
  checkpointId?: unknown;
  patch?: unknown;
  files?: Array<{
    path?: unknown;
    oldPath?: unknown;
    status?: unknown;
    additions?: unknown;
    deletions?: unknown;
    binary?: unknown;
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
function decodeTurnReviewCapabilityValue(value: TurnReviewCapabilityValue): {
  leadPatch: string | null;
  snapshotKind: string;
  checkpointId: string;
  files: TurnReviewFile[];
  reviews: AgentTurnReview[];
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
  return { leadPatch, snapshotKind, checkpointId, files, reviews };
}

/** Collapsed headline (file count, line stats, attribution) plus the diff
 *  style toggle the expanded bar owns. */
function turnReviewHead({
  expanded,
  setExpanded,
  setOpenFile,
  setConfirmFile,
  setRevertError,
  summary,
  headlineStats,
  transcriptSummary,
  agentSummary,
  agentSources,
  authoritativeWorktreeSnapshot,
  diffStyle,
  setDiffStyle,
}: {
  expanded: boolean;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  setOpenFile(value: string): void;
  setConfirmFile(value: string): void;
  setRevertError(value: string): void;
  summary: TurnReviewSummary;
  headlineStats: { hasLineStats: boolean; additions: number; deletions: number };
  transcriptSummary: TurnReviewSummary;
  agentSummary: TurnReviewSummary;
  agentSources: Array<{ key: string; label: string; summary: TurnReviewSummary }>;
  authoritativeWorktreeSnapshot: boolean;
  diffStyle: 'unified' | 'split';
  setDiffStyle(style: 'unified' | 'split'): void;
}) {
  return (
    <div className="turn-review-head">
      <button
        type="button"
        className="turn-review-summary"
        aria-expanded={expanded}
        onClick={() =>
          setExpanded((value) => {
            const next = !value;
            // Collapsing also closes any open inline diff/confirm so reopening
            // starts from the tidy list, not a tall stale diff.
            if (!next) {
              setOpenFile('');
              setConfirmFile('');
              setRevertError('');
            }
            return next;
          })
        }
      >
        <FileDiff size={14} aria-hidden="true" />
        <strong>
          {summary.files.size === 1 ? t('1 file changed') : t('{{count}} files changed', { count: summary.files.size })}
        </strong>
        {/* The counters belong to the TITLE, not to the (now removed)
            expander side of the row. */}
        {headlineStats.hasLineStats && (
          <span className="diff-stats">
            {headlineStats.additions > 0 && <i>+{headlineStats.additions}</i>}
            {headlineStats.deletions > 0 && <em>-{headlineStats.deletions}</em>}
          </span>
        )}
        {agentSources.length > 0 && (
          <span className="turn-review-attribution">
            {authoritativeWorktreeSnapshot
              ? t('Agents {{agents}} attributed', { agents: agentSummary.files.size })
              : t('Lead {{lead}} · Agents {{agents}}', {
                  lead: transcriptSummary.files.size,
                  agents: agentSummary.files.size,
                })}
          </span>
        )}
      </button>
      {expanded && (
        <div className="turn-review-controls">
          <div className="review-style-toggle turn-review-style" role="radiogroup" aria-label={t('Diff style')}>
            <button type="button" aria-pressed={diffStyle === 'unified'} onClick={() => setDiffStyle('unified')}>
              {t('Unified')}
            </button>
            <button type="button" aria-pressed={diffStyle === 'split'} onClick={() => setDiffStyle('split')}>
              {t('Split')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Per-file revert to the start of the turn, behind an explicit confirm step.
 *  The runtime decides at click time; a refusal is surfaced, never swallowed. */
function turnReviewRevertControl({
  name,
  rel,
  confirming,
  canRevertFile,
  sessionId,
  requestedCheckpointId,
  turnBoundaryKey,
  setConfirmFile,
  setRevertError,
  setReverted,
  setRevertedBoundary,
  refreshAgentReviews,
}: {
  name: string;
  rel: string;
  confirming: boolean;
  canRevertFile: boolean;
  sessionId: string | undefined;
  requestedCheckpointId: string;
  turnBoundaryKey: string;
  setConfirmFile(value: string): void;
  setRevertError(value: string): void;
  setReverted: Dispatch<SetStateAction<string[]>>;
  setRevertedBoundary(value: string): void;
  refreshAgentReviews(refreshWorktree?: boolean): Promise<void>;
}) {
  if (!confirming) {
    return (
      <button
        type="button"
        className="turn-review-revert"
        aria-label={t('Revert {{file}}', { file: rel })}
        data-tooltip={t('Revert file to turn start')}
        disabled={!canRevertFile}
        onClick={() => setConfirmFile(name)}
      >
        <Undo2 size={12} />
      </button>
    );
  }
  return (
    <span
      className="turn-review-confirm"
      role="group"
      aria-label={t('Confirm reverting {{file}} to the start of this turn', { file: rel })}
    >
      <button
        type="button"
        className="turn-review-revert"
        aria-label={t('Cancel revert')}
        data-tooltip={t('Cancel')}
        onClick={() => setConfirmFile('')}
      >
        <X size={12} />
      </button>
      <button
        type="button"
        className="turn-review-revert danger"
        aria-label={t('Confirm revert of {{file}}', { file: rel })}
        data-tooltip={t('Revert to turn start')}
        onClick={() => {
          setConfirmFile('');
          setRevertError('');
          void window.mixdogDesktop
            .invokeCapability?.({
              capability: 'revertTurnReviewFile',
              args: [rel, requestedCheckpointId],
              sessionId,
            })
            .then(async () => {
              setReverted((current) => [...current, name]);
              setRevertedBoundary(turnBoundaryKey);
              await refreshAgentReviews();
            })
            .catch((reason: unknown) => setRevertError(errorMessageText(reason)));
        }}
      >
        <Check size={12} />
      </button>
    </span>
  );
}

/** One changed file: status, project-relative path, line stats, the open-file
 *  action, its revert slot, and the inline diff it discloses. */
function turnReviewFileRow({
  entry,
  rel,
  rowKey,
  isReverted,
  openFile,
  setOpenFile,
  cwd,
  onOpenFile,
  diffStyle,
  revertControl,
}: {
  entry: TurnReviewFileEntry;
  rel: string;
  rowKey: string;
  isReverted: boolean;
  openFile: string;
  setOpenFile: Dispatch<SetStateAction<string>>;
  cwd: string | undefined;
  onOpenFile: ((project: string, rel: string) => void) | undefined;
  diffStyle: 'unified' | 'split';
  revertControl: ReactNode;
}) {
  const code = statusCode(entry);
  const label = statusLabel(entry);
  return (
    <li key={rowKey} data-open={openFile === rowKey ? 'true' : 'false'} data-reverted={isReverted ? 'true' : 'false'}>
      <button
        type="button"
        className="turn-review-file"
        aria-expanded={openFile === rowKey}
        onClick={() => setOpenFile((current) => (current === rowKey ? '' : rowKey))}
      >
        <span className="turn-review-status" data-status={code} aria-label={label} data-tooltip={label}>
          {code}
        </span>
        <code>{rel}</code>
        {entry.lineStats && (
          <span className="diff-stats">
            <i>{entry.additions > 0 ? `+${entry.additions}` : ''}</i>
            <em>{entry.deletions > 0 ? `-${entry.deletions}` : ''}</em>
          </span>
        )}
        {!entry.lineStats && (
          <span className="diff-stats" aria-hidden="true">
            <i />
            <em />
          </span>
        )}
      </button>
      <span className="turn-review-action-slot">
        <button
          type="button"
          className="turn-review-open"
          aria-label={t('Open file {{file}}', { file: rel })}
          data-tooltip={t('Open file')}
          disabled={!cwd || !onOpenFile || (code === 'D' && !isReverted)}
          onClick={() => {
            if (cwd) onOpenFile?.(cwd, rel);
          }}
        >
          <FileText size={12} aria-hidden="true" />
        </button>
        {revertControl}
      </span>
      {openFile === rowKey && (
        <div className="turn-review-diff">
          {entry.parts.length > 0 ? (
            entry.parts.map((file, index) => <GitDiffBody key={`${rowKey}:${index}`} file={file} mode={diffStyle} />)
          ) : (
            <span className="turn-review-status">{t('Diff detail unavailable')}</span>
          )}
        </div>
      )}
    </li>
  );
}

export const TurnReviewBar = memo(function TurnReviewBar({
  items,
  cwd,
  sessionId,
  active = true,
  busy = false,
  onPendingChange,
  onOpenFile,
}: {
  items: TranscriptItem[];
  cwd?: string;
  sessionId?: string;
  active?: boolean;
  busy?: boolean;
  onOpenFile?: (project: string, rel: string) => void;
  /** True until the authoritative read for the current boundary settles,
   *  including a queued completion refresh. Delivered before paint. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openFile, setOpenFile] = useState('');
  const [confirmFile, setConfirmFile] = useState('');
  const [reverted, setReverted] = useState<string[]>([]);
  // A refused revert used to vanish into an empty catch, so a legitimate
  // runtime refusal was indistinguishable from a dead button.
  const [revertError, setRevertError] = useState('');
  // The turn boundary at which the last revert succeeded. Until a new tool
  // completes, the runtime's (now emptier) diff outranks the transcript's
  // per-edit uiDiff, which still describes the mutation that was just undone.
  const [revertedBoundary, setRevertedBoundary] = useState('');
  // An expanded review closes on the first pointer press OUTSIDE its own box.
  // Presses inside (rows, revert, diff style) keep it open, so the disclosure
  // never collapses under its own controls.
  const barElement = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!expanded) return undefined;
    const closeOnOutsidePointer = (event: Event) => {
      const element = barElement.current;
      const target = event.target as Node | null;
      if (!element || (target && element.contains(target))) return;
      setExpanded(false);
      setOpenFile('');
      setConfirmFile('');
      setRevertError('');
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [expanded]);
  const reviewScope = useMemo(() => turnReviewScope(items), [items]);
  const turnScopeKey = `${String(sessionId || 'draft')}:${reviewScope.key}`;
  const activeScope = useRef(turnScopeKey);
  activeScope.current = turnScopeKey;
  const [agentReviewState, setAgentReviewState] = useState<{
    scopeKey: string;
    reviews: AgentTurnReview[];
    leadPatch: string | null;
    files: TurnReviewFile[];
    snapshotKind: string;
    checkpointId: string;
  }>(() => cachedTurnReviewState(turnScopeKey));
  // Keying the read as well as the write prevents a one-frame stale bar before
  // effects run when the user switches sessions or opens New task.
  const reviewState =
    agentReviewState.scopeKey === turnScopeKey ? agentReviewState : cachedTurnReviewState(turnScopeKey);
  const agentReviews = reviewState.reviews;
  const authoritativeLeadPatch = reviewState.leadPatch;
  const authoritativeLeadFiles = reviewState.files;
  const authoritativeSnapshotKind = reviewState.snapshotKind;
  const authoritativeCheckpointId = reviewState.checkpointId;
  // A recorded ("scoped") review is the same Git diff as a live worktree
  // baseline, only limited to the session's own paths, so its file list is
  // trusted the same way. Otherwise a revert served from the record left the
  // transcript's stale diff on screen and looked like nothing had happened.
  const authoritativeWorktreeSnapshot =
    authoritativeSnapshotKind === 'worktree' || authoritativeSnapshotKind === 'scoped';
  const capabilityRequestInFlight = useRef(false);
  // The read issued in the current synchronous pass (one commit's effects),
  // cleared at the next microtask.
  const sameCommitRequest = useRef<{ scopeKey: string; boundaryKey: string; refreshWorktree: boolean } | null>(
    null
  );
  const pendingCapabilityRefresh = useRef<{
    scopeKey: string;
    refreshWorktree: boolean;
  } | null>(null);
  const refreshAgentReviewsRef = useRef<(refreshWorktree?: boolean) => Promise<void>>(async () => undefined);
  const lastAgentReviewSignature = useRef<string | null>(null);
  useEffect(() => {
    pendingCapabilityRefresh.current = null;
    lastAgentReviewSignature.current = null;
    setExpanded(false);
    setOpenFile('');
    setConfirmFile('');
    setReverted([]);
    setRevertedBoundary('');
  }, [turnScopeKey]);
  // Only probe once the transcript shows turn activity: a fresh/empty session
  // has no child review and passive mounts must not fire capability calls.
  const hasTurnActivity = reviewScope.hasActivity;
  // Refresh on turn boundaries, not every streaming transcript publication.
  const turnBoundaryKey = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (!item) continue;
      if (item.kind === 'turndone' || item.kind === 'statusdone' || item.kind === 'tool') {
        return `${String(item.id ?? index)}:${String(item.completedAt ?? item.completedCount ?? '')}`;
      }
    }
    return '';
  }, [items]);
  const reviewBoundaryKey = JSON.stringify([turnScopeKey, turnBoundaryKey, busy]);
  const initialBoundary = useRef({ scope: turnScopeKey, key: reviewBoundaryKey });
  if (initialBoundary.current.scope !== turnScopeKey) {
    initialBoundary.current = { scope: turnScopeKey, key: reviewBoundaryKey };
  }
  const [settledBoundary, setSettledBoundary] = useState('');
  // The scope whose authoritative read has come back (or could not run). A
  // scope already answered in the shared cache is settled from its first
  // render, so revisiting a session never re-reserves the slot.
  const [settledScope, setSettledScope] = useState('');
  const refreshAgentReviews = useCallback(
    async (refreshWorktree = false) => {
      const api = window.mixdogDesktop as
        | {
            invokeCapability?: (request: {
              capability: string;
              args: unknown[];
              sessionId?: string;
            }) => Promise<{ value?: unknown }>;
          }
        | undefined;
      const requestedScope = turnScopeKey;
      const settle = () => {
        if (activeScope.current === requestedScope) {
          setSettledScope(requestedScope);
          setSettledBoundary(reviewBoundaryKey);
        }
      };
      if (!sessionId || !api?.invokeCapability) {
        settle();
        return;
      }
      if (document.visibilityState === 'hidden') {
        settle();
        return;
      }
      if (capabilityRequestInFlight.current) {
        // The boundary effect and the busy poll both ask when one commit moves
        // a boundary: the read already sent for it answers both, so a queued
        // follow-up would only repeat it.
        const issued = sameCommitRequest.current;
        if (
          issued?.scopeKey === requestedScope &&
          issued.boundaryKey === reviewBoundaryKey &&
          (issued.refreshWorktree || !refreshWorktree)
        ) {
          return;
        }
        const pending = pendingCapabilityRefresh.current;
        pendingCapabilityRefresh.current = {
          scopeKey: requestedScope,
          refreshWorktree: refreshWorktree || (pending?.scopeKey === requestedScope && pending.refreshWorktree),
        };
        return;
      }
      capabilityRequestInFlight.current = true;
      const issued = { scopeKey: requestedScope, boundaryKey: reviewBoundaryKey, refreshWorktree };
      sameCommitRequest.current = issued;
      queueMicrotask(() => {
        if (sameCommitRequest.current === issued) sameCommitRequest.current = null;
      });
      try {
        // This bar belongs to the pane's session. During a tab switch the host's
        // focused view can already point elsewhere, so omitting this address
        // mixed another turn's diff into the bar and could hit a stale view.
        const result = await api.invokeCapability({
          capability: TURN_REVIEW_CAPABILITY,
          args: [{ refresh: refreshWorktree }],
          sessionId,
        });
        const decoded = decodeTurnReviewCapabilityValue((result?.value ?? null) as TurnReviewCapabilityValue);
        if (!decoded) {
          return;
        }
        const { leadPatch, snapshotKind, checkpointId, files, reviews } = decoded;
        const signature = JSON.stringify([leadPatch, files, snapshotKind, checkpointId, reviews]);
        rememberAgentReviews(requestedScope, reviews, leadPatch, files, snapshotKind, checkpointId);
        if (lastAgentReviewSignature.current === signature) return;
        lastAgentReviewSignature.current = signature;
        if (activeScope.current === requestedScope) {
          setAgentReviewState({
            scopeKey: requestedScope,
            reviews,
            leadPatch,
            files,
            snapshotKind,
            checkpointId,
          });
        }
      } catch {
        // The next turn boundary, visibility change, expansion, or bounded idle
        // refresh retries. A transient read must never permanently lock Revert.
      } finally {
        capabilityRequestInFlight.current = false;
        const pending = pendingCapabilityRefresh.current;
        pendingCapabilityRefresh.current = null;
        if (pending && activeScope.current === pending.scopeKey) {
          void refreshAgentReviewsRef.current(pending.refreshWorktree);
        } else {
          settle();
        }
      }
    },
    [sessionId, turnScopeKey, reviewBoundaryKey]
  );
  refreshAgentReviewsRef.current = refreshAgentReviews;
  const reviewPending = reviewScopePending({
    active,
    hasTurnActivity,
    sessionId: String(sessionId || ''),
    scopeKey: turnScopeKey,
    settledScope,
    cached: leadReviewCheckpointIdCache.has(turnScopeKey),
    refreshPending: reviewBoundaryKey !== initialBoundary.current.key && settledBoundary !== reviewBoundaryKey,
  });
  // Layout effect: the host reads this in the same pre-paint pass, so the
  // reservation and the resolved bar land in one committed frame.
  useLayoutEffect(() => {
    onPendingChange?.(reviewPending);
  }, [onPendingChange, reviewPending]);
  useLayoutEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  useEffect(() => {
    // A tool/turn boundary is the authoritative point at which the visible
    // count must catch up. If an older request is still running, the callback
    // above coalesces this into one mandatory follow-up refresh instead of
    // dropping the final file set and leaving an earlier count on screen.
    if (active && hasTurnActivity) void refreshAgentReviews(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- turnBoundaryKey stands in for items
  }, [active, busy, refreshAgentReviews, hasTurnActivity, turnBoundaryKey]);
  useEffect(() => {
    if (!active || (!hasTurnActivity && agentReviews.length === 0)) return undefined;
    // While a turn is active (or the review is open), keep the display fresh.
    // Once idle, use a bounded backoff window to catch a late child completion
    // without leaving every mounted session on a permanent six-second poll.
    if (busy || expanded) {
      void refreshAgentReviews(true);
      const timer = window.setInterval(() => {
        void refreshAgentReviews(true);
      }, 6_000);
      return () => window.clearInterval(timer);
    }
    const delays = [6_000, 12_000, 24_000, 48_000];
    let index = 0;
    let timer = 0;
    const schedule = () => {
      if (index >= delays.length) return;
      timer = window.setTimeout(() => {
        index += 1;
        void refreshAgentReviews(false);
        schedule();
      }, delays[index]);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [active, busy, expanded, refreshAgentReviews, hasTurnActivity, agentReviews.length, turnBoundaryKey]);
  // The bar's own persisted Unified/Split choice, separate from the Source
  // Control and Session Diff tabs (user: 3개 분리 저장).
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>(() => readDiffStyle(TURN_REVIEW_DIFF_STYLE_KEY));
  useEffect(() => {
    writeDiffStyle(TURN_REVIEW_DIFF_STYLE_KEY, diffStyle);
  }, [diffStyle]);
  const transcriptSummary = useMemo(() => {
    const patches: string[] = [];
    let latestUiDiff: string | null = null;
    for (let index = reviewScope.startIndex + 1; index < items.length; index++) {
      const item = items[index];
      if (item?.kind !== 'tool') continue;
      if (Object.hasOwn(item, 'uiDiff')) {
        latestUiDiff = typeof item.uiDiff === 'string' ? item.uiDiff : '';
        continue;
      }
      const count = Math.max(1, Number(item.count || 1));
      const failed = item.isError === true || Number(item.errorCount || 0) >= count;
      if (failed) continue;
      // Shell/test output can legitimately contain `@@` or a printed unified
      // diff. It is evidence to show inside that tool row, not evidence that
      // the tool changed files. Shell mutations arrive through the
      // authoritative worktree snapshot instead.
      if (!toolPublishesPatch(item)) continue;
      const patch = findPatch(item);
      if (typeof patch !== 'string' || !patch) continue;
      patches.push(patch);
    }
    // The completed tool item is published in the same frame as the mutation
    // and therefore beats the polled capability snapshot during rapid,
    // same-card edits. An explicit empty uiDiff is authoritative too: it means
    // the latest apply_patch restored the turn baseline.
    if (authoritativeWorktreeSnapshot) {
      return summarizeAuthoritativeTurnReview(authoritativeLeadFiles, authoritativeLeadPatch || '');
    }
    // After a revert the transcript's uiDiff is exactly the change that was
    // undone, so the runtime's exact-tracker diff wins until the next tool
    // completes and moves the boundary.
    const afterRevert =
      revertedBoundary !== '' && revertedBoundary === turnBoundaryKey && authoritativeLeadPatch !== null;
    return summarizeTurnReviewPatch(
      afterRevert ? authoritativeLeadPatch : (latestUiDiff ?? authoritativeLeadPatch ?? patches.join('\n'))
    );
  }, [
    authoritativeLeadFiles,
    authoritativeLeadPatch,
    authoritativeWorktreeSnapshot,
    items,
    reviewScope.startIndex,
    revertedBoundary,
    turnBoundaryKey,
  ]);
  const agentSources = useMemo(
    () =>
      agentReviews.flatMap((review, index) => {
        const reviewSummary = summarizeTurnReviewPatch(review.patch);
        if (reviewSummary.files.size === 0) return [];
        const label =
          review.tag && review.agent && review.tag !== review.agent
            ? `${review.tag} · ${review.agent}`
            : review.tag || review.agent || '';
        return [
          {
            key: `${review.sessionId}:${index}`,
            label,
            summary: reviewSummary,
          },
        ];
      }),
    [agentReviews]
  );
  const agentSummary = useMemo(
    () => mergeTurnReviewSummaries(agentSources.map((source) => source.summary)),
    [agentSources]
  );
  const summary = useMemo(
    () =>
      authoritativeWorktreeSnapshot ? transcriptSummary : mergeTurnReviewSummaries([transcriptSummary, agentSummary]),
    [transcriptSummary, agentSummary, authoritativeWorktreeSnapshot]
  );
  const operationSummary = useMemo(
    () => summarizeTurnReviewOperations(items, reviewScope.startIndex),
    [items, reviewScope.startIndex]
  );
  // The file set and expanded rows remain the authoritative turn-start → current
  // diff. The collapsed headline mirrors the activity cards' edit workload so
  // replaced/deleted intermediate lines do not disappear into a net +N count.
  const headlineStats = operationSummary.hasLineStats ? operationSummary : summary;
  const sources = useMemo(() => {
    const transcriptSource = {
      key: authoritativeWorktreeSnapshot ? 'turn' : 'lead',
      label: authoritativeWorktreeSnapshot ? 'Turn' : 'Lead',
      summary: transcriptSummary,
    };
    return [...(transcriptSummary.files.size > 0 ? [transcriptSource] : []), ...agentSources];
  }, [transcriptSummary, agentSources, authoritativeWorktreeSnapshot]);
  const reviewVisible = summary.files.size > 0;
  const requestedCheckpointId = reviewScope.key === 'none' ? authoritativeCheckpointId : reviewScope.key;
  const checkpointMatches = !authoritativeCheckpointId || authoritativeCheckpointId === requestedCheckpointId;
  // Revert availability is decided by the runtime at click time. A transient
  // or stale capability read must not permanently disable an otherwise valid
  // checkpoint, but a known ID mismatch is never allowed to hit another turn.
  const canRevertTurn = Boolean(cwd && sessionId && requestedCheckpointId && checkpointMatches);
  // Tool patches sometimes carry ABSOLUTE paths; display and revert use the
  // project-relative form (git confinement expects it).
  const normalizedCwd = String(cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  // The prior turn's review must leave at the next user boundary. Conversation
  // reserves geometry only after the CURRENT turn actually touches files, so
  // carrying an empty review row through every busy turn creates a fixed black
  // gap above the composer while new output streams above it.
  if (!reviewVisible) return null;
  return (
    <section
      ref={barElement}
      className="turn-review-bar"
      aria-label={t('Files changed this turn')}
      data-expanded={expanded ? 'true' : 'false'}
    >
      {turnReviewHead({
        expanded,
        setExpanded,
        setOpenFile,
        setConfirmFile,
        setRevertError,
        summary,
        headlineStats,
        transcriptSummary,
        agentSummary,
        agentSources,
        authoritativeWorktreeSnapshot,
        diffStyle,
        setDiffStyle,
      })}
      {/* A refusal stays OUTSIDE the disclosure so its reason is readable
          without expanding the bar. */}
      {revertError && <ErrorNotice error={revertError} />}
      <div className="turn-review-collapse" inert={!expanded} aria-hidden={!expanded}>
        <div className="turn-review-collapse-inner">
          <ul className="turn-review-files">
            {sources.flatMap((source) => {
              const sourceHeader = (
                <li key={`${source.key}:source`} className="turn-review-source">
                  {/* Turn/Lead are catalog keys; agent tags are user data, never keys. */}
                  <strong>
                    {source.key === 'turn' || source.key === 'lead' ? t(source.label) : source.label || t('Agent')}
                  </strong>
                  <span className="diff-stats" aria-hidden={!source.summary.hasLineStats}>
                    <i>{source.summary.additions > 0 ? `+${source.summary.additions}` : ''}</i>
                    <em>{source.summary.deletions > 0 ? `-${source.summary.deletions}` : ''}</em>
                  </span>
                </li>
              );
              const rows = [...source.summary.files.entries()].map(([name, entry]) => {
                const normalizedName = name.replace(/\\/g, '/');
                const rel =
                  normalizedCwd && normalizedName.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)
                    ? normalizedName.slice(normalizedCwd.length + 1)
                    : normalizedName;
                const rowKey = `${source.key}:${name}`;
                const isReverted = reverted.includes(name);
                const confirming = confirmFile === name;
                const ownFile = source.key === 'turn' || source.key === 'lead';
                const canRevertFile = ownFile && canRevertTurn && !busy && !isReverted;
                return turnReviewFileRow({
                  entry,
                  rel,
                  rowKey,
                  isReverted,
                  openFile,
                  setOpenFile,
                  cwd,
                  onOpenFile,
                  diffStyle,
                  revertControl:
                    ownFile && !isReverted
                      ? turnReviewRevertControl({
                          name,
                          rel,
                          confirming,
                          canRevertFile,
                          sessionId,
                          requestedCheckpointId,
                          turnBoundaryKey,
                          setConfirmFile,
                          setRevertError,
                          setReverted,
                          setRevertedBoundary,
                          refreshAgentReviews,
                        })
                      : null,
                });
              });
              return [sourceHeader, ...rows];
            })}
          </ul>
        </div>
      </div>
    </section>
  );
});
