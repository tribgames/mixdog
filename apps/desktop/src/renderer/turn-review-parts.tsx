import { Check, FileDiff, FileText, Undo2, X } from 'lucide-react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { t } from './i18n';
import { errorMessageText } from './ErrorNotice';
import { GitDiffBody } from './ReviewPane';
import { IslandSegLabel } from './ComposerIsland';
import { TurnReviewFilesMenu } from './turn-review-files-menu';
import { statusLabel, statusCode, type TurnReviewFileEntry, type TurnReviewSummary } from './turn-review-model';

type HeadlineStats = { hasLineStats: boolean; additions: number; deletions: number };
type TurnReviewSource = { key: string; label: string; summary: TurnReviewSummary };

/** Collapsed headline (file count, line stats, attribution) plus the diff
 *  style toggle the expanded bar owns. */
export function turnReviewHead({
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
  headlineStats: HeadlineStats;
  transcriptSummary: TurnReviewSummary;
  agentSummary: TurnReviewSummary;
  agentSources: TurnReviewSource[];
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

/** The island's collapsed "Files N +a −b" segment: a menu of View changes
 *  (the side dock's session diff, or the island tab's file list) and Delete
 *  history. */
export function turnReviewSegment({
  fileCount,
  headlineStats,
  onOpenChanges,
  setExpanded,
  sessionId,
  historyTurns,
  busy,
}: {
  fileCount: number;
  headlineStats: HeadlineStats;
  onOpenChanges: (() => void) | undefined;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  sessionId: string | undefined;
  historyTurns: number;
  busy: boolean;
}) {
  return (
    <TurnReviewFilesMenu
      sessionId={sessionId}
      historyTurns={historyTurns}
      busy={busy}
      label={t('Files changed this session')}
      title={t('Files {{count}}', { count: fileCount })}
      onViewChanges={onOpenChanges ?? (() => setExpanded(true))}
    >
      <IslandSegLabel text={t('Island: {{count}} files', { count: fileCount })} count={fileCount} icon="file-diff" />
      {headlineStats.hasLineStats && (
        <span className="diff-stats">
          {headlineStats.additions > 0 && <i>+{headlineStats.additions}</i>}
          {headlineStats.additions > 0 && headlineStats.deletions > 0 && ' '}
          {headlineStats.deletions > 0 && <em>−{headlineStats.deletions}</em>}
        </span>
      )}
    </TurnReviewFilesMenu>
  );
}

type RevertWiring = {
  sessionId: string | undefined;
  requestedCheckpointId: string;
  turnBoundaryKey: string;
  setConfirmFile(value: string): void;
  setRevertError(value: string): void;
  setReverted: Dispatch<SetStateAction<string[]>>;
  setRevertedBoundary(value: string): void;
  refreshAgentReviews(refreshWorktree?: boolean): Promise<void>;
};

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
}: RevertWiring & {
  name: string;
  rel: string;
  confirming: boolean;
  canRevertFile: boolean;
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
    // biome-ignore lint/a11y/useSemanticElements: inline span inside a row; a fieldset would change layout and DOM
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

type RowWiring = {
  openFile: string;
  setOpenFile: Dispatch<SetStateAction<string>>;
  cwd: string | undefined;
  onOpenFile: ((project: string, rel: string) => void) | undefined;
  diffStyle: 'unified' | 'split';
};

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
}: RowWiring & {
  entry: TurnReviewFileEntry;
  rel: string;
  rowKey: string;
  isReverted: boolean;
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
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label gives the status letter an accessible name; adding a role would change semantics */}
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
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional per entry and never reorder
            entry.parts.map((file, index) => <GitDiffBody key={`${rowKey}:${index}`} file={file} mode={diffStyle} />)
          ) : (
            <span className="turn-review-status">{t('Diff detail unavailable')}</span>
          )}
        </div>
      )}
    </li>
  );
}

/** Every source's header row followed by its file rows. */
export function turnReviewFileItems({
  sources,
  cwd,
  reverted,
  confirmFile,
  canRevertTurn,
  busy,
  ...wiring
}: RowWiring &
  RevertWiring & {
    sources: TurnReviewSource[];
    reverted: string[];
    confirmFile: string;
    canRevertTurn: boolean;
    busy: boolean;
  }) {
  const { openFile, setOpenFile, onOpenFile, diffStyle } = wiring;
  // Tool patches sometimes carry ABSOLUTE paths; display and revert use the
  // project-relative form (git confinement expects it).
  const normalizedCwd = String(cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return sources.flatMap((source) => {
    const sourceHeader = (
      <li key={`${source.key}:source`} className="turn-review-source">
        {/* Turn/Lead are catalog keys; agent tags are user data, never keys. */}
        <strong>
          {source.key === 'turn' || source.key === 'lead' || source.key === 'session'
            ? t(source.label)
            : source.label || t('Agent')}
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
                sessionId: wiring.sessionId,
                requestedCheckpointId: wiring.requestedCheckpointId,
                turnBoundaryKey: wiring.turnBoundaryKey,
                setConfirmFile: wiring.setConfirmFile,
                setRevertError: wiring.setRevertError,
                setReverted: wiring.setReverted,
                setRevertedBoundary: wiring.setRevertedBoundary,
                refreshAgentReviews: wiring.refreshAgentReviews,
              })
            : null,
      });
    });
    return [sourceHeader, ...rows];
  });
}
