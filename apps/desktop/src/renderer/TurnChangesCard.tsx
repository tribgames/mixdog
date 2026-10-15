import { ArrowUpRight, Check, ChevronDown, FileDiff, Redo2, Undo2, X } from 'lucide-react';
import {
  createContext,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { t } from './i18n';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { showDesktopToast } from './desktop-toasts';
import { SetiFileIcon } from './SetiFileIcon';
import { requestSessionDiffFile, requestSessionDiffList } from './session-diff-focus';
import { isAbsolutePath } from './session-diff-model';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import {
  invokeTurnChanges,
  REAPPLY_TURN_CHANGES_CAPABILITY,
  REVERT_TURN_CHANGES_CAPABILITY,
  splitChangePath,
  turnChangeOpenPath,
  turnChangesTitle,
  turnChangesTotals,
  useTurnChanges,
  withTranscriptCounts,
  visibleTurnChangeRows,
  type TurnChangesCapability,
  type TurnChangesFile,
  type TurnChangesRef,
  type TurnChangesReply,
} from './turn-changes-model';

/** What the transcript hands every card: its session, whether that session is
 *  busy, whether its latest turn is still running, and the pane's routes. */
export type TurnChangesSurface = {
  sessionId: string;
  busy: boolean;
  /** The session runs a turn no visible prompt has followed yet: the
   *  trailing card belongs to it and stays hidden. */
  turnRunning: boolean;
  /** Opens the pane's session diff (the composer files segment's route). */
  onOpenSessionDiff?: () => void;
  onOpenFile?: (project: string, rel: string) => void;
};

export const TurnChangesContext = createContext<TurnChangesSurface | null>(null);

function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stats">
      {additions > 0 && <i>+{additions}</i>}
      {deletions > 0 && (
        <em>
          {'\u2212'}
          {deletions}
        </em>
      )}
    </span>
  );
}

type ActivateChange = (event: ReactMouseEvent, file: TurnChangesFile | null) => void;
type MutateChanges = (capability: TurnChangesCapability, file: string | null, success: string) => void;

/** A per-file action: revert an applied file, or reapply a reverted one. */
function fileActionOf(file: TurnChangesFile) {
  const target = { file: file.path };
  if (file.state === 'reverted') {
    return {
      reapply: true,
      capability: REAPPLY_TURN_CHANGES_CAPABILITY,
      success: t('Reapplied {{file}}', target),
      trigger: t('Reapply {{file}}', target),
      tooltip: t('Reapply file from this turn'),
      group: t('Confirm reapplying {{file}} from this turn', target),
      cancel: t('Cancel reapply'),
      confirm: t('Confirm reapply of {{file}}', target),
      confirmTooltip: t('Reapply file from this turn'),
    } as const;
  }
  return {
    reapply: false,
    capability: REVERT_TURN_CHANGES_CAPABILITY,
    success: t('Reverted {{file}}', target),
    trigger: t('Revert {{file}}', target),
    tooltip: t('Revert file to turn start'),
    group: t('Confirm reverting {{file}} to the start of this turn', target),
    cancel: t('Cancel revert'),
    confirm: t('Confirm revert of {{file}}', target),
    confirmTooltip: t('Revert to turn start'),
  } as const;
}

/** The cancel / confirm pair of the composer turn review's confirm step. */
function ConfirmControl({
  group,
  cancel,
  confirm,
  confirmTooltip,
  danger,
  groupRef,
  onCancel,
  onConfirm,
}: {
  group: string;
  cancel: string;
  confirm: string;
  confirmTooltip: string;
  danger: boolean;
  groupRef?: RefObject<HTMLSpanElement | null>;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: inline span inside a row; a fieldset would change layout and DOM
    <span className="turn-review-confirm" role="group" aria-label={group} ref={groupRef}>
      <button
        type="button"
        className="turn-review-revert"
        aria-label={cancel}
        data-tooltip={t('Cancel')}
        onClick={onCancel}
      >
        <X size={12} />
      </button>
      <button
        type="button"
        className={danger ? 'turn-review-revert danger' : 'turn-review-revert'}
        aria-label={confirm}
        data-tooltip={confirmTooltip}
        onClick={onConfirm}
      >
        <Check size={12} />
      </button>
    </span>
  );
}

/** Per-file revert or reapply, behind the confirm step. */
function FileActionControl({
  file,
  confirming,
  blockedReason,
  setConfirmFile,
  onMutate,
}: {
  file: TurnChangesFile;
  confirming: boolean;
  blockedReason: string;
  setConfirmFile(path: string): void;
  onMutate: MutateChanges;
}) {
  const action = fileActionOf(file);
  const disabled = Boolean(blockedReason) || !file.revertable;
  const showConfirm = confirming && !disabled;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<Element | null>(null);
  // Focus follows the swap: into the confirm pair on entry, back to the
  // trigger once it leaves (the trigger is disabled while a mutation runs, so
  // the restore waits until it can take focus).
  const restoreFocus = useRef(false);
  useEffect(() => {
    cardRef.current = (triggerRef.current ?? groupRef.current)?.closest('.turn-changes-card') ?? cardRef.current;
    if (showConfirm) {
      restoreFocus.current = true;
      if (!groupRef.current?.contains(document.activeElement)) groupRef.current?.querySelector('button')?.focus();
    } else if (restoreFocus.current && triggerRef.current && !triggerRef.current.disabled) {
      restoreFocus.current = false;
      triggerRef.current.focus();
    }
  });
  // The row went away (the file left the list) while focus was owed to it:
  // land on the card's header button instead of the document.
  useEffect(
    () => () => {
      if (restoreFocus.current) cardRef.current?.querySelector<HTMLElement>('.turn-changes-summary')?.focus();
    },
    []
  );
  if (showConfirm) {
    return (
      <ConfirmControl
        groupRef={groupRef}
        group={action.group}
        cancel={action.cancel}
        confirm={action.confirm}
        confirmTooltip={action.confirmTooltip}
        danger={!action.reapply}
        onCancel={() => setConfirmFile('')}
        onConfirm={() => onMutate(action.capability, file.path, action.success)}
      />
    );
  }
  const fileBlocked = blockedReason || (file.revertable ? '' : file.reason || '');
  return (
    <button
      ref={triggerRef}
      type="button"
      className={action.reapply ? 'turn-review-revert turn-changes-reapply' : 'turn-review-revert'}
      aria-label={action.trigger}
      data-tooltip={fileBlocked || action.tooltip}
      disabled={disabled}
      onClick={() => setConfirmFile(file.path)}
    >
      {action.reapply ? <Redo2 size={12} /> : <Undo2 size={12} />}
    </button>
  );
}

/** Whole-turn Undo, or Reapply once the turn is fully undone. */
function turnActionOf({ canUndo, canReapply, reason }: Pick<TurnChangesReply, 'canUndo' | 'canReapply' | 'reason'>) {
  if (canReapply && !canUndo) {
    return {
      reapply: true,
      enabled: true,
      capability: REAPPLY_TURN_CHANGES_CAPABILITY,
      label: t('Reapply'),
      tooltip: t('Reapply the changes from this turn'),
      success: t('Changes reapplied'),
    } as const;
  }
  return {
    reapply: false,
    enabled: canUndo,
    capability: REVERT_TURN_CHANGES_CAPABILITY,
    label: t('Undo'),
    tooltip: (canUndo ? '' : reason) || t('Undo the changes from this turn'),
    success: t('Changes undone'),
  } as const;
}

function TurnActionButton({
  canUndo,
  canReapply,
  reason,
  blockedReason,
  onMutate,
}: Pick<TurnChangesReply, 'canUndo' | 'canReapply' | 'reason'> & { blockedReason: string; onMutate: MutateChanges }) {
  const action = turnActionOf({ canUndo, canReapply, reason });
  return (
    <button
      type="button"
      className="turn-changes-action"
      disabled={Boolean(blockedReason) || !action.enabled}
      data-tooltip={blockedReason || action.tooltip}
      aria-label={action.label}
      onClick={() => onMutate(action.capability, null, action.success)}
    >
      <span className="turn-changes-label">{action.label}</span>
      {action.reapply ? <Redo2 size={11} aria-hidden="true" /> : <Undo2 size={11} aria-hidden="true" />}
    </button>
  );
}

/** The header's summary button: icon, then title and totals on one line. */
function TurnChangesSummary({ files, activate }: { files: readonly TurnChangesFile[]; activate: ActivateChange }) {
  const totals = turnChangesTotals(files);
  return (
    <button type="button" className="turn-changes-summary" onClick={(event) => activate(event, null)}>
      <span className="turn-changes-icon" aria-hidden="true">
        <FileDiff size={14} />
      </span>
      <span className="turn-changes-title">
        <strong>{turnChangesTitle(files)}</strong>
        <DiffStats additions={totals.additions} deletions={totals.deletions} />
        <span className="turn-changes-hint">
          {t('View changes')}
          <ArrowUpRight size={12} aria-hidden="true" />
        </span>
      </span>
    </button>
  );
}

function TurnChangesFileRow({
  file,
  activate,
  action,
}: {
  file: TurnChangesFile;
  activate: ActivateChange;
  action: ReactNode;
}) {
  const { base, directory } = splitChangePath(file.path);
  const outside = isAbsolutePath(file.path);
  return (
    <li className="turn-changes-file" data-reverted={file.state === 'reverted' ? 'true' : 'false'}>
      <button
        type="button"
        className="turn-changes-file-main"
        title={file.path}
        onClick={(event) => activate(event, file)}
      >
        <SetiFileIcon name={base} className="turn-changes-file-icon" />
        {!outside && directory && <span className="turn-changes-prefix">{directory}</span>}
        <span className="turn-changes-base">{base}</span>
        <DiffStats additions={file.additions} deletions={file.deletions} />
      </button>
      <span className="turn-changes-file-actions">{action}</span>
    </li>
  );
}

function moreFilesLabel(expanded: boolean, hidden: number): string {
  if (expanded) return t('Collapse files');
  if (hidden === 1) return t('Show 1 more file');
  return t('Show {{count}} more files', { count: hidden });
}

/** The listed rows plus the Show more / Collapse toggle. */
function TurnChangesFileList({
  files,
  renderRow,
}: {
  files: readonly TurnChangesFile[];
  renderRow(file: TurnChangesFile): ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const { rows, hidden } = visibleTurnChangeRows(files, expanded);
  if (rows.length === 0) return null;
  return (
    <ul className="turn-changes-files">
      {rows.map((file) => renderRow(file))}
      {(hidden > 0 || expanded) && (
        <li className="turn-changes-more-row">
          <button
            type="button"
            className="turn-changes-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {moreFilesLabel(expanded, hidden)}
            <ChevronDown size={11} aria-hidden="true" data-open={expanded ? 'true' : 'false'} />
          </button>
        </li>
      )}
    </ul>
  );
}

/** Undo / Reapply calls, their error, and the per-file confirm step. */
function useTurnChangesMutation({
  sessionId,
  checkpointId,
  busy,
  adopt,
  invalidate,
}: {
  sessionId: string;
  checkpointId: string;
  busy: boolean;
  adopt(next: TurnChangesReply): void;
  invalidate(): void;
}) {
  const [confirmFile, setConfirmFile] = useState('');
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState('');
  const mutate = (revision: number, capability: TurnChangesCapability, file: string | null, success: string) => {
    if (mutating || busy) return;
    setMutating(true);
    setError('');
    setConfirmFile('');
    void invokeTurnChanges(capability, [checkpointId, file, revision], sessionId)
      .then((next) => {
        adopt(next);
        // The worktree moved: every Git surface (Source Control, the Changes chip) re-reads.
        window.dispatchEvent(new Event('mixdog:git-changed'));
        showDesktopToast(success, 'success');
      })
      .catch((reason: unknown) => {
        // The runtime refuses a stale revision (another client changed the
        // turn): keep the message and reread, so a retry uses the current one.
        setError(errorMessageText(reason));
        invalidate();
      })
      .finally(() => setMutating(false));
  };
  return { confirmFile, setConfirmFile, mutating, error, setError, mutate };
}

/** Ctrl/Cmd+click opens the file; a click opens the session diff on it (on
 *  the whole diff for the header), or the file when there is no diff route. */
function activateTurnChange(
  event: ReactMouseEvent,
  file: TurnChangesFile | null,
  surface: TurnChangesSurface,
  root: string
) {
  const openFile = (target: TurnChangesFile) => {
    const path = turnChangeOpenPath(target);
    if (root && path) surface.onOpenFile?.(root, path);
  };
  if (file && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    openFile(file);
    return;
  }
  if (!surface.onOpenSessionDiff) {
    if (file) openFile(file);
    return;
  }
  if (file) requestSessionDiffFile(surface.sessionId, file.path, root);
  else requestSessionDiffList(surface.sessionId);
  surface.onOpenSessionDiff();
}

function TurnChangesCardBody({
  surface,
  checkpointId,
  boundary,
  trailing,
}: { surface: TurnChangesSurface } & TurnChangesRef) {
  const { sessionId } = surface;
  const running = trailing && surface.turnRunning;
  const { reply, adopt, invalidate } = useTurnChanges({ sessionId, checkpointId, boundary, enabled: !running });
  const mutation = useTurnChangesMutation({ sessionId, checkpointId, busy: surface.busy, adopt, invalidate });
  // Old records kept no counts for an outside-root file: the transcript's own
  // edit completes them, as in the session pane and the island.
  const needsCounts = Boolean(reply?.files.some((file) => file.unmeasured));
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, undefined, needsCounts);
  const files = useMemo(
    () => withTranscriptCounts(reply?.files ?? [], needsCounts ? lane?.items : undefined, reply?.root ?? ''),
    [reply, needsCounts, lane]
  );
  if (running || !reply || reply.status !== 'ready' || reply.files.length === 0) return null;

  const { revision } = reply;
  const blockedReason = surface.busy || mutation.mutating ? t('Unavailable while the session is busy') : '';
  const mutate: MutateChanges = (capability, file, success) => mutation.mutate(revision, capability, file, success);
  const activate: ActivateChange = (event, file) => {
    activateTurnChange(event, file, surface, reply.root);
  };
  return (
    <section className="turn-changes-card" aria-label={t('Turn changes')} data-file-count={files.length}>
      <div className="turn-changes-head">
        <TurnChangesSummary files={files} activate={activate} />
        <span className="turn-changes-trail">
          <TurnActionButton
            canUndo={reply.canUndo}
            canReapply={reply.canReapply}
            reason={reply.reason}
            blockedReason={blockedReason}
            onMutate={mutate}
          />
          <button
            type="button"
            className="turn-changes-view"
            aria-label={t('View changes')}
            onClick={(event) => activate(event, null)}
          >
            <span className="turn-changes-label">{t('View changes')}</span>
            <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        </span>
      </div>
      {mutation.error && (
        <ErrorNotice className="turn-changes-error" error={mutation.error} onDismiss={() => mutation.setError('')} />
      )}
      <TurnChangesFileList
        files={files}
        renderRow={(file) => (
          <TurnChangesFileRow
            key={file.path}
            file={file}
            activate={activate}
            action={
              <FileActionControl
                file={file}
                confirming={mutation.confirmFile === file.path}
                blockedReason={blockedReason}
                setConfirmFile={mutation.setConfirmFile}
                onMutate={mutate}
              />
            }
          />
        )}
      />
    </section>
  );
}

/** A turn's changed-files card (Codex-style), after the last turndone of its
 *  checkpoint. Renders nothing outside a session surface, while its turn
 *  runs, or when the runtime reports no (or no longer any) recorded change. */
export const TurnChangesCard = memo(function TurnChangesCard({ turnChanges }: { turnChanges: TurnChangesRef }) {
  const surface = useContext(TurnChangesContext);
  if (!surface?.sessionId) return null;
  return (
    <TurnChangesCardBody
      key={`${surface.sessionId}\u0000${turnChanges.checkpointId}`}
      surface={surface}
      checkpointId={turnChanges.checkpointId}
      boundary={turnChanges.boundary}
      trailing={turnChanges.trailing}
    />
  );
});
