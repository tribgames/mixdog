import { ArrowUpRight, Check, ChevronDown, FileDiff, Redo2, Undo2, X } from 'lucide-react';
import {
  createContext,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { t } from './i18n';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { showDesktopToast } from './desktop-toasts';
import { publishReviewInvalidation } from './review-invalidation';
import { SetiFileIcon } from './SetiFileIcon';
import { requestSessionDiffTurn } from './session-diff-focus';
import { DiffStats } from './diff-stats';
import { ownedFocus } from './own-scroll-writes';
import { isAbsolutePath } from './session-diff-model';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import { MarkdownProjectContext } from './MarkdownLink';
import type { TranscriptRowModel } from './transcript-rows';
import {
  invokeTurnChanges,
  REAPPLY_TURN_CHANGES_CAPABILITY,
  REVERT_TURN_CHANGES_CAPABILITY,
  splitChangePath,
  turnChangeOpenPath,
  turnChangesTitle,
  turnChangesTotals,
  allChangesVisualized,
  listedTurnChanges,
  recordedTurnChanges,
  turnCardHeld,
  useTurnChanges,
  visibleTurnChangeRows,
  type TurnChangesCapability,
  type TurnChangesFile,
  type TurnChangesRef,
  type TurnChangesReply,
  type TurnRecord,
} from './turn-changes-model';

/** What the transcript hands every card: its session, whether that session is
 *  busy, whether its latest turn is still running, and the pane's routes. */
export type TurnChangesSurface = {
  sessionId: string;
  busy: boolean;
  /** The turn the transcript's last end closed still runs (the session has
   *  not been idle since, and nothing is past that end): the trailing card
   *  is its own and stays hidden. */
  turnRunning: boolean;
  /** Opens the pane's session diff (the composer files segment's route). */
  onOpenSessionDiff?: () => void;
  onOpenFile?: (project: string, rel: string) => void;
};

export const TurnChangesContext = createContext<TurnChangesSurface | null>(null);

/** The cards (by checkpoint) of one session view whose read gave another height than the row was presented with,
 *  while the row was in view: the row keeps what it shows, also when it is mounted again, until it is out of view.
 *  The set is the view's own, and goes with it. */
export const TurnCardsWithheldContext = createContext<Set<string> | null>(null);

/** The rows of the transcript a card stands in: what its turn's own records say it changed (`recordedTurnChanges`). */
export const TurnRowsContext = createContext<(() => readonly TranscriptRowModel[]) | null>(null);

/** The recorded turn a tool round belongs to: its file links open that turn's
 *  changes, listed as its card lists them. `checkpointId` is '' while the turn
 *  runs, or without one. */
export type ToolTurn = TurnRecord & { visualized?: readonly string[] };

const ToolTurnContext = createContext<ToolTurn>({ checkpointId: '', boundary: '' });

export const useToolTurn = () => useContext(ToolTurnContext);

export function ToolTurnProvider({ checkpointId, boundary, visualized, children }: ToolTurn & { children: ReactNode }) {
  const turn = useMemo(() => ({ checkpointId, boundary, visualized }), [checkpointId, boundary, visualized]);
  return <ToolTurnContext.Provider value={turn}>{children}</ToolTurnContext.Provider>;
}

type TranscriptItems = Parameters<typeof listedTurnChanges>[1];
const NO_FILES: readonly TurnChangesFile[] = [];
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
  pressable,
  setConfirmFile,
  onMutate,
}: {
  file: TurnChangesFile;
  confirming: boolean;
  blockedReason: string;
  /** The card takes a press on a blocked control (it updates the card): the control still sends it. */
  pressable: boolean;
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
      if (!groupRef.current?.contains(document.activeElement)) ownedFocus(groupRef.current?.querySelector('button'));
    } else if (restoreFocus.current && triggerRef.current && !triggerRef.current.disabled) {
      restoreFocus.current = false;
      ownedFocus(triggerRef.current);
    }
  });
  // The row went away (the file left the list) while focus was owed to it:
  // land on the card's header button instead of the document.
  useEffect(
    () => () => {
      if (restoreFocus.current) ownedFocus(cardRef.current?.querySelector<HTMLElement>('.turn-changes-summary'));
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
      disabled={disabled && !pressable}
      aria-disabled={disabled && pressable ? true : undefined}
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
  pressable = false,
  onMutate,
}: Pick<TurnChangesReply, 'canUndo' | 'canReapply' | 'reason'> & {
  blockedReason: string;
  /** The card takes a press on a blocked control (it updates the card): the control still sends it. */
  pressable?: boolean;
  onMutate: MutateChanges;
}) {
  const action = turnActionOf({ canUndo, canReapply, reason });
  const blocked = Boolean(blockedReason) || !action.enabled;
  return (
    <button
      type="button"
      className="turn-changes-action"
      disabled={blocked && !pressable}
      aria-disabled={blocked && pressable ? true : undefined}
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
        publishReviewInvalidation(sessionId);
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

/** Ctrl/Cmd+click opens the file; a click opens the diff pane on this turn's
 *  own changes (on the file, or on every file for the header), or the file
 *  when there is no diff route. */
function activateTurnChange(
  event: ReactMouseEvent,
  file: TurnChangesFile | null,
  surface: TurnChangesSurface,
  record: TurnRecord,
  root: string,
  visualized: readonly string[] | undefined
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
  requestSessionDiffTurn(surface.sessionId, record, file?.path ?? '', { visualized });
  surface.onOpenSessionDiff();
}

function TurnChangesCardBody({
  surface,
  checkpointId,
  boundary,
  trailing,
  reclosed,
  frame,
  visualized,
}: {
  surface: TurnChangesSurface;
  frame?: (card: ReactNode) => ReactNode;
  visualized?: readonly string[];
} & TurnChangesRef) {
  const { sessionId } = surface;
  const running = turnCardHeld({ checkpointId, boundary, trailing, reclosed }, surface.turnRunning);
  const {
    reply: read,
    error,
    stalled,
    adopt,
    invalidate,
  } = useTurnChanges({
    sessionId,
    checkpointId,
    boundary,
    enabled: !running,
  });
  // No view waits for the core's read, and what a read brings later displaces nothing the reader is looking at.
  // Until the read answers, the card is the one the turn's own rows describe (the files its edit and write calls
  // name), drawn in the row's first frame. The read's card is laid out in its place and measured before it is
  // painted: as tall as what the row showed, it stays. Of another height (more or fewer files, a wrapped line, a card
  // where none was drawn, none where one was), it stays too unless rows in view would move for it; then the row goes
  // back to what it showed, in that same frame, until the row is out of view, the list follows the end with nothing
  // in view below the row (where a growing last row keeps the view on the end), or the reader presses the card.
  const rowsOf = useContext(TurnRowsContext);
  const project = useContext(MarkdownProjectContext) || '';
  const withheld = useContext(TurnCardsWithheldContext);
  const records = useRef<TurnChangesReply | null | undefined>(undefined);
  if (records.current === undefined && !running && rowsOf && (read === null || withheld?.has(checkpointId))) {
    records.current = recordedTurnChanges(rowsOf(), checkpointId, project);
  }
  const recorded = records.current ?? null;
  /** The read the row shows; null while it shows the records' card (or none). */
  const [given, setGiven] = useState<TurnChangesReply | null>(() => (withheld?.has(checkpointId) ? null : read));
  /** The read kept back from the row. */
  const [held, setHeld] = useState<TurnChangesReply | null>(() => (withheld?.has(checkpointId) ? read : null));
  const listedOf = (from: TurnChangesReply | null, counts?: TranscriptItems): readonly TurnChangesFile[] =>
    from && from.status === 'ready' ? listedTurnChanges(from.files, counts, visualized, from.root) : NO_FILES;
  /** A read neither shown nor kept back: this render lays it out to be measured. */
  const trying = read !== null && read !== given && read !== held;
  const superseded = read !== null && read === held;
  const acted = useRef(false);
  const seat = useRef<HTMLElement | null>(null);
  const shownHeight = useRef<number | null>(null);
  const take = (next: TurnChangesReply): void => {
    acted.current = false;
    withheld?.delete(checkpointId);
    setHeld(null);
    setGiven(next);
  };
  /** Whether a change of this card's height would move rows the reader is looking at. `left`: the row was left
   *  with its read kept back, so a pane coming back shows it as it was. */
  const displaces = (left: boolean): boolean => {
    const row = seat.current?.closest<HTMLElement>('.transcript-virtual-row');
    const view = row?.closest<HTMLElement>('.transcript');
    if (!row || !view || acted.current) return false;
    if (!left && row.closest('[data-transcript-entering]')) return false;
    const box = row.getBoundingClientRect();
    const port = view.getBoundingClientRect();
    // A row with no box (its pane is not rendered) says nothing of where it is.
    if (box.height <= 0 || port.height <= 0) return true;
    if (box.bottom <= port.top || box.top >= port.bottom) return false;
    if (view.dataset.following !== 'true') return true;
    // Rows are placed by their offsets, not by their order in the document.
    return [...(row.parentElement?.children ?? [])].some((other) => {
      const next = other.getBoundingClientRect();
      return other !== row && next.height > 0 && next.top >= box.bottom - 1 && next.top < port.bottom;
    });
  };
  const seatHeight = (): number => seat.current?.getBoundingClientRect().height ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: every commit: the height shown is the one last laid out
  useLayoutEffect(() => {
    if (running) return;
    const height = seatHeight();
    if (!trying) {
      shownHeight.current = height;
      return;
    }
    if (shownHeight.current === null || height === shownHeight.current || !displaces(false)) {
      shownHeight.current = height;
      take(read);
    } else {
      withheld?.add(checkpointId);
      setHeld(read);
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: displaces and take read the row as it stands
  useLayoutEffect(() => {
    if (!superseded) return undefined;
    const row = seat.current?.closest('.transcript-virtual-row');
    const give = (): void => take(read);
    if (!row || typeof IntersectionObserver === 'undefined' || !displaces(true)) {
      give();
      return undefined;
    }
    withheld?.add(checkpointId);
    const leftView = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting && entry.boundingClientRect.height > 0)) give();
    });
    leftView.observe(row);
    // The list comes to follow the end.
    const follows = new MutationObserver(() => {
      if (!displaces(true)) give();
    });
    const view = row.closest('.transcript');
    if (view) follows.observe(view, { attributes: true, attributeFilter: ['data-following'] });
    return () => {
      leftView.disconnect();
      follows.disconnect();
    };
  }, [superseded, read, withheld, checkpointId]);
  const reply = trying ? read : (given ?? recorded);
  const fromRecords = !trying && given === null && recorded !== null;
  const mutation = useTurnChangesMutation({
    sessionId,
    checkpointId,
    busy: surface.busy,
    adopt: (next) => {
      // The reader acted on the card: its answer is the card's, whatever its height.
      acted.current = true;
      adopt(next);
    },
    invalidate,
  });
  // Old records kept no counts for an outside-root file: the transcript's own
  // edit completes them, as in the session pane and the island.
  const needsCounts = Boolean(reply?.files.some((file) => file.unmeasured));
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, undefined, needsCounts);
  // A file the turn showed as a visualize card stands as that card, not as a
  // diff; Undo still covers the whole turn from this card (or, when every
  // file was shown, from the visualize card: TurnChangesUndo).
  // biome-ignore lint/correctness/useExhaustiveDependencies: listedOf reads visualized, which is listed
  const listed = useMemo(
    () => listedOf(reply, needsCounts ? lane?.items : undefined),
    [reply, needsCounts, lane, visualized]
  );
  if (running) return null;
  // No card shown, and one that may come: the row is found from here.
  if (!reply || listed.length === 0) return superseded || trying ? <span hidden ref={seat} /> : null;

  const { revision } = reply;
  const unread = fromRecords && Boolean(error || stalled);
  /** The card waits on the reader: a press on it updates it. */
  const waits = superseded || unread;
  // Why the card's actions wait, said as it is.
  const waitingReason = superseded
    ? t('This card is being updated with the turn\u2019s recorded changes. Click it to update it now.')
    : !fromRecords
      ? ''
      : error
        ? t('Reading this turn\u2019s changes failed ({{error}}). Click the card to read them again.', { error })
        : stalled
          ? t('This turn\u2019s changes are still being recorded. Click the card to read them again.')
          : t('Reading this turn\u2019s changes');
  const blockedReason =
    surface.busy || mutation.mutating ? t('Unavailable while the session is busy') : waitingReason;
  const mutate: MutateChanges = (capability, file, success) => mutation.mutate(revision, capability, file, success);
  const activate: ActivateChange = (event, file) => {
    activateTurnChange(event, file, surface, { checkpointId, boundary }, reply.root, visualized);
  };
  /** A press on a card that waits. One the read has superseded takes the read's card, and the press does nothing
   *  else: it never acts on what the old card listed. One whose read failed or stalled asks again; a press on a
   *  control that waits for the read does only that. */
  const press = (event: ReactMouseEvent): void => {
    const blocked = (event.target as Element).closest?.('[aria-disabled="true"]');
    if (superseded || blocked) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (superseded) take(read);
    else invalidate();
  };
  const card = (
    <section
      ref={seat}
      className="turn-changes-card"
      aria-label={t('Turn changes')}
      data-file-count={listed.length}
      data-source={fromRecords ? 'records' : undefined}
      data-read={superseded ? 'updating' : unread ? (error ? 'failed' : 'stalled') : undefined}
      title={waits ? waitingReason : undefined}
      onClickCapture={waits ? press : undefined}
    >
      <div className="turn-changes-head">
        <TurnChangesSummary files={listed} activate={activate} />
        <span className="turn-changes-trail">
          <TurnActionButton
            canUndo={reply.canUndo}
            canReapply={reply.canReapply}
            reason={reply.reason}
            blockedReason={blockedReason}
            pressable={waits}
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
        files={listed}
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
                pressable={waits}
                setConfirmFile={mutation.setConfirmFile}
                onMutate={mutate}
              />
            }
          />
        )}
      />
    </section>
  );
  return frame ? frame(card) : card;
}

/** A turn's changed-files card; renders nothing outside a session surface, while its turn runs, or without recorded changes. `frame` seats a shown card. */
export const TurnChangesCard = memo(function TurnChangesCard({
  turnChanges,
  frame,
  visualized,
}: {
  turnChanges: TurnChangesRef;
  frame?: (card: ReactNode) => ReactNode;
  /** The files the turn showed as visualize cards (not listed here). */
  visualized?: readonly string[];
}) {
  const surface = useContext(TurnChangesContext);
  if (!surface?.sessionId) return null;
  return (
    <TurnChangesCardBody
      key={`${surface.sessionId}\u0000${turnChanges.checkpointId}`}
      surface={surface}
      checkpointId={turnChanges.checkpointId}
      boundary={turnChanges.boundary}
      trailing={turnChanges.trailing}
      reclosed={turnChanges.reclosed}
      frame={frame}
      visualized={visualized}
    />
  );
});

function TurnChangesUndoBody({
  surface,
  checkpointId,
  boundary,
  trailing,
  reclosed,
  visualized,
}: { surface: TurnChangesSurface; visualized: readonly string[] } & TurnChangesRef) {
  const { sessionId } = surface;
  const running = turnCardHeld({ checkpointId, boundary, trailing, reclosed }, surface.turnRunning);
  const { reply, adopt, invalidate } = useTurnChanges({ sessionId, checkpointId, boundary, enabled: !running });
  const mutation = useTurnChangesMutation({ sessionId, checkpointId, busy: surface.busy, adopt, invalidate });
  const { error, setError } = mutation;
  useEffect(() => {
    if (!error) return;
    showDesktopToast(errorMessageText(error), 'error');
    setError('');
  }, [error, setError]);
  if (running || !reply || reply.status !== 'ready' || !allChangesVisualized(reply.files, visualized, reply.root))
    return null;
  const blockedReason = surface.busy || mutation.mutating ? t('Unavailable while the session is busy') : '';
  return (
    <TurnActionButton
      canUndo={reply.canUndo}
      canReapply={reply.canReapply}
      reason={reply.reason}
      blockedReason={blockedReason}
      onMutate={(capability, file, success) => mutation.mutate(reply.revision, capability, file, success)}
    />
  );
}

/** The turn's Undo / Reapply on its visualize card, when every changed file
 *  was shown as a visualize card and so the changes card is not drawn. */
export function TurnChangesUndo({
  turnChanges,
  visualized,
}: {
  turnChanges: TurnChangesRef;
  visualized: readonly string[];
}) {
  const surface = useContext(TurnChangesContext);
  if (!surface?.sessionId) return null;
  return (
    <TurnChangesUndoBody
      key={`${surface.sessionId}\u0000${turnChanges.checkpointId}`}
      surface={surface}
      checkpointId={turnChanges.checkpointId}
      boundary={turnChanges.boundary}
      trailing={turnChanges.trailing}
      reclosed={turnChanges.reclosed}
      visualized={visualized}
    />
  );
}
