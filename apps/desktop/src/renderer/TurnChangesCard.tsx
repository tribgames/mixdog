import { Check, ChevronDown, ChevronRight, FileDiff, Redo2, Undo2, X } from 'lucide-react';
import {
  createContext,
  lazy,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { showDesktopToast } from './desktop-toasts';
import { requestSessionDiffFile } from './session-diff-focus';
import {
  fetchTurnChangesPreview,
  invokeTurnChanges,
  REAPPLY_TURN_CHANGES_CAPABILITY,
  REVERT_TURN_CHANGES_CAPABILITY,
  splitChangePath,
  turnChangeOpenPath,
  turnChangesPreviewGap,
  turnChangesTitle,
  turnChangesTotals,
  useTurnChanges,
  visibleTurnChangeRows,
  type TurnChangesCapability,
  type TurnChangesFile,
  type TurnChangesRef,
  type TurnChangesReply,
} from './turn-changes-model';

const TurnChangesPreviewDiff = lazy(() => import('./turn-changes-preview'));

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

const HOVER_DELAY_MS = 250;
const PREVIEW_WIDTH = 440;

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

type PreviewRect = { top: number; bottom: number; left: number };
type PreviewAnchor = { file: TurnChangesFile; rect: PreviewRect };
type PreviewState = { patch: string | null; failed: boolean };
type PreviewHandlers = (file: TurnChangesFile) => {
  onMouseEnter(event: ReactMouseEvent<HTMLElement>): void;
  onMouseLeave(): void;
  'aria-describedby': string | undefined;
};
type ActivateChange = (event: ReactMouseEvent, file: TurnChangesFile | null) => void;
type MutateChanges = (capability: TurnChangesCapability, file: string | null, success: string) => void;

function previewNote(text: string) {
  return <p className="turn-changes-preview-note">{text}</p>;
}

function previewGapNote(gap: 'binary' | 'large' | 'empty'): string {
  if (gap === 'binary') return t('Binary file — no preview');
  if (gap === 'large') return t('Too large to preview');
  return t('No preview available');
}

function previewBody(file: TurnChangesFile, { patch, failed }: PreviewState): ReactNode {
  if (file.binary) return previewNote(previewGapNote('binary'));
  const gap = patch === null ? null : turnChangesPreviewGap(file, patch);
  if (gap) return previewNote(previewGapNote(gap));
  if (failed) return previewNote(t('Preview unavailable'));
  if (patch === null) return previewNote(t('Loading preview…'));
  return (
    <Suspense fallback={previewNote(t('Loading preview…'))}>
      <TurnChangesPreviewDiff patch={patch} />
    </Suspense>
  );
}

/** Below the row, or above it when the viewport has more room there. */
function previewPosition(rect: PreviewRect) {
  const viewportWidth = window.innerWidth || PREVIEW_WIDTH;
  const viewportHeight = window.innerHeight || 0;
  const left = Math.max(8, Math.min(rect.left + 24, viewportWidth - PREVIEW_WIDTH - 8));
  const above = viewportHeight > 0 && viewportHeight - rect.bottom < 240 && rect.top > viewportHeight - rect.bottom;
  return above ? { left, bottom: viewportHeight - rect.top + 4 } : { left, top: rect.bottom + 4 };
}

/** Hover tooltip: the file's diff for this turn. Portaled, because transcript
 *  rows clip their own overflow. */
function TurnChangesPreviewTip({
  id,
  sessionId,
  checkpointId,
  revision,
  anchor,
}: {
  id: string;
  sessionId: string;
  checkpointId: string;
  revision: number;
  anchor: PreviewAnchor;
}) {
  const { file, rect } = anchor;
  const binary = Boolean(file.binary);
  const [state, setState] = useState<PreviewState>({ patch: null, failed: false });
  useEffect(() => {
    if (binary) return undefined;
    let stale = false;
    setState({ patch: null, failed: false });
    fetchTurnChangesPreview(sessionId, checkpointId, revision, file.path).then(
      (patch) => {
        if (!stale) setState({ patch, failed: false });
      },
      () => {
        if (!stale) setState({ patch: null, failed: true });
      }
    );
    return () => {
      stale = true;
    };
  }, [binary, sessionId, checkpointId, revision, file.path]);
  return createPortal(
    <div id={id} className="turn-changes-preview" role="tooltip" style={previewPosition(rect)}>
      <div className="turn-changes-preview-head">
        <span>{splitChangePath(file.path).base}</span>
        <DiffStats additions={file.additions} deletions={file.deletions} />
      </div>
      <div className="turn-changes-preview-body">{previewBody(file, state)}</div>
    </div>,
    document.body
  );
}

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
  onCancel,
  onConfirm,
}: {
  group: string;
  cancel: string;
  confirm: string;
  confirmTooltip: string;
  danger: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: inline span inside a row; a fieldset would change layout and DOM
    <span className="turn-review-confirm" role="group" aria-label={group}>
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
  if (confirming && !disabled) {
    return (
      <ConfirmControl
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
      onClick={() => onMutate(action.capability, null, action.success)}
    >
      {action.label}
      {action.reapply ? <Redo2 size={11} aria-hidden="true" /> : <Undo2 size={11} aria-hidden="true" />}
    </button>
  );
}

/** The header's summary button: title, totals, and "View changes" on hover. */
function TurnChangesSummary({
  files,
  activate,
  previewHandlers,
}: {
  files: readonly TurnChangesFile[];
  activate: ActivateChange;
  previewHandlers: PreviewHandlers;
}) {
  const single = files.length === 1 ? files[0] : undefined;
  const totals = turnChangesTotals(files);
  return (
    <button
      type="button"
      className="turn-changes-summary"
      title={single?.path}
      onClick={(event) => activate(event, single ?? null)}
      {...(single ? previewHandlers(single) : {})}
    >
      <span className="turn-changes-icon" aria-hidden="true">
        <FileDiff size={14} />
      </span>
      <span className="turn-changes-title">
        <strong>{turnChangesTitle(files)}</strong>
        <span className="turn-changes-sub turn-changes-sub-default">
          <DiffStats additions={totals.additions} deletions={totals.deletions} />
        </span>
        <span className="turn-changes-sub turn-changes-sub-hover">
          {t('View changes')}
          <ChevronRight size={10} aria-hidden="true" />
        </span>
      </span>
    </button>
  );
}

function TurnChangesFileRow({
  file,
  activate,
  previewHandlers,
  action,
}: {
  file: TurnChangesFile;
  activate: ActivateChange;
  previewHandlers: PreviewHandlers;
  action: ReactNode;
}) {
  const { directory, base } = splitChangePath(file.path);
  return (
    <li className="turn-changes-file" data-reverted={file.state === 'reverted' ? 'true' : 'false'}>
      <button
        type="button"
        className="turn-changes-file-main"
        title={file.path}
        onClick={(event) => activate(event, file)}
        {...previewHandlers(file)}
      >
        <span className="turn-changes-path">
          {directory && <span className="turn-changes-dir">{directory}</span>}
          <span className="turn-changes-base">{base}</span>
        </span>
        {file.binary && <span className="turn-changes-large">{previewGapNote('binary')}</span>}
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

/** The listed rows plus the Show more / Collapse toggle; nothing for one file. */
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

/** Hover preview state: the anchored file after a short delay. */
function useTurnChangesPreview() {
  const [preview, setPreview] = useState<PreviewAnchor | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previewId = useId();
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const hidePreview = () => {
    clearTimeout(hoverTimer.current);
    setPreview(null);
  };
  const previewHandlers: PreviewHandlers = (file) => ({
    onMouseEnter: (event) => {
      const box = event.currentTarget.getBoundingClientRect();
      const rect = { top: box.top, bottom: box.bottom, left: box.left };
      clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => setPreview({ file, rect }), HOVER_DELAY_MS);
    },
    onMouseLeave: hidePreview,
    'aria-describedby': preview?.file.path === file.path ? previewId : undefined,
  });
  return { preview, previewId, hidePreview, previewHandlers };
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
  requestSessionDiffFile(surface.sessionId, file ? file.path : null);
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
  const { preview, previewId, hidePreview, previewHandlers } = useTurnChangesPreview();
  if (running || !reply || reply.status !== 'ready' || reply.files.length === 0) return null;

  const { files, revision } = reply;
  const blockedReason = surface.busy || mutation.mutating ? t('Unavailable while the session is busy') : '';
  const mutate: MutateChanges = (capability, file, success) => mutation.mutate(revision, capability, file, success);
  const activate: ActivateChange = (event, file) => {
    hidePreview();
    activateTurnChange(event, file, surface, reply.root);
  };
  return (
    <section
      className="turn-changes-card"
      aria-label={t('Turn changes')}
      data-file-count={files.length}
      data-reverted={files.length === 1 && files[0]?.state === 'reverted' ? 'true' : undefined}
    >
      <div className="turn-changes-head">
        <TurnChangesSummary files={files} activate={activate} previewHandlers={previewHandlers} />
        <span className="turn-changes-trail">
          <TurnActionButton
            canUndo={reply.canUndo}
            canReapply={reply.canReapply}
            reason={reply.reason}
            blockedReason={blockedReason}
            onMutate={mutate}
          />
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
            previewHandlers={previewHandlers}
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
      {preview && (
        <TurnChangesPreviewTip
          id={previewId}
          sessionId={sessionId}
          checkpointId={checkpointId}
          revision={revision}
          anchor={preview}
        />
      )}
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
