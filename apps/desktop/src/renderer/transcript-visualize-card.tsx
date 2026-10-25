// The chat card of a turn's `visualize` opens: ONE card per Lead turn, stamped
// under the reply once the turn ended (like the changed-files card) on each
// tab's final version. A tile per distinct panel tab: the picture of its
// version, its title, version and where it is (shown in the panel, updated
// behind another tab, an earlier version, closed); a tile shows its tab in
// the session's side panel (or opens it again once closed), "Show all" brings
// every tab of the turn up. Coding mode draws it under the reply, agent mode
// in the bubble column. Remote clients draw it from their mirrored state.
// Beside the agent's opens, the turn's previews (turn-preview-model.ts): the
// files it changed that the panel can show, filled in at its end.
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  CodeXml,
  Columns3,
  FileText,
  FileType,
  Image,
  LayoutGrid,
  type LucideIcon,
  Music,
  PenTool,
  Video,
  Workflow,
} from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { agentPoolStore } from './agent-activity-model';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { usePersistedThumbnail } from './persisted-thumbnail';
import {
  monogramHue,
  noteVisualizeCards,
  noteVisualizeTurnCards,
  previewFileLabel,
  subscribeVisualizeCards,
  type VisualizeCardCall,
  type VisualizeCardKind,
  visualizeCardCalls,
  visualizeCardKind,
  visualizeCardLiveThumbnail,
  visualizeCardNewest,
  visualizeCardOwnVersion,
  visualizeCardSupersededInTurn,
  visualizeCardsShown,
  visualizeCardTab,
  visualizeCardThumbnailLine,
  visualizeCardVersion,
  visualizeCardVersionTarget,
  visualizeInlineKindLabel,
  visualizeOwnerSessionId,
  visualizeTabForTargets,
  visualizeTurnEndAt,
  visualizedTargets,
} from './visualize-card-model';
import { TurnChangesCard, TurnChangesContext, TurnChangesUndo } from './TurnChangesCard';
import { type TurnChangesFile, type TurnChangesRef, useTurnChanges } from './turn-changes-model';
import {
  claimTurnPreviewEnd,
  noteTurnPreviewTargets,
  subscribeTurnPreviews,
  takeTurnPreviewOpen,
  turnPreviewBadgeFor,
  turnPreviewFiles,
  turnPreviewOpenOrder,
  turnPreviewOpenPending,
  turnPreviewPage,
  turnPreviewTargets,
} from './turn-preview-model';
import type { VisualizeTabView } from '../shared/visualize';
import {
  openTurnPreviews,
  readVisualizeVersionThumbnail,
  reopenVisualizeContent,
  reopenVisualizeTargets,
  requestVisualizeVersion,
  revealVisualizeTab,
  useVisualizeState,
  useVisualizeHeldSince,
  useVisualizePanelOnScreen,
  visualizeStateFor,
} from './visualize-store';
import './transcript-visualize-card.css';

/** The placeholder icon of each kind (no picture, or none yet). */
const KIND_ICONS: Record<VisualizeCardKind, LucideIcon> = {
  html: CodeXml,
  image: Image,
  markdown: FileText,
  mermaid: Workflow,
  svg: PenTool,
  chart: BarChart3,
  pdf: FileType,
  document: FileType,
  audio: Music,
  video: Video,
  split: Columns3,
};

/** The version a card stands for: the newest card follows its tab, an earlier
 *  one keeps the version its own turn ended on (an open that named no version
 *  on a tab that keeps them made its first). */
function cardVersion(
  sessionId: string,
  call: VisualizeCardCall,
  tab: VisualizeTabView | null,
  newest: boolean
): number {
  return (
    visualizeCardOwnVersion(sessionId, call, visualizeCardVersion(tab), newest, tab) || (tab?.versions?.length ? 1 : 0)
  );
}

/** Show the call's tab on the card's version in the side panel, or open it
 *  again when it was closed (no agent turn). Rejects when the card's version
 *  cannot be shown (the card then says why). */
function openCall(sessionId: string, call: VisualizeCardCall): Promise<void> {
  const tab = visualizeCardTab(visualizeStateFor(sessionId), call);
  if (tab) {
    const newest = visualizeCardNewest(sessionId, call);
    const version = cardVersion(sessionId, call, tab, newest);
    revealVisualizeTab(sessionId, tab.id);
    const target = visualizeCardVersionTarget(call, tab, version, newest);
    return (tab.version ?? null) !== target ? requestVisualizeVersion(sessionId, tab.id, target) : Promise.resolve();
  }
  // A preview never opened has no tab id yet; main's reopen does not use it.
  const tabId = call.tabId || 'preview';
  return call.content
    ? reopenVisualizeContent(sessionId, tabId, call.content, call.label)
    : reopenVisualizeTargets(sessionId, tabId, call.targets, call.label);
}

function tileState(closed: boolean, newest: boolean): string {
  if (closed) return 'closed';
  return newest ? 'open' : 'folded';
}

/** One tile of the turn's card: the picture of the tab's version, its title,
 *  version and where it is. Drawn only once the turn ended (ToolVisualizeCards). */
function VisualizeTile({
  call,
  sessionId,
  onOpen,
}: {
  call: VisualizeCardCall;
  sessionId: string;
  onOpen: (call: VisualizeCardCall) => void;
}) {
  const state = useVisualizeState(sessionId);
  const newest = useSyncExternalStore(
    subscribeVisualizeCards,
    () => visualizeCardNewest(sessionId, call),
    () => true
  );
  const tab = visualizeCardTab(state, call);
  // A preview with no tab (not opened, or its tab gone) is a plain tile its
  // click opens, never a dimmed "closed" one.
  const closed = tab === null && !call.preview;
  const version = cardVersion(sessionId, call, tab, newest);
  // The picture of this version, taken when its turn ended: from the tab while
  // it has it, else the copy saved under that version (a closed tile, an
  // earlier one, a restart), else asked of the host once.
  const tabId = tab?.id ?? '';
  const thumbnail = usePersistedThumbnail(
    sessionId,
    call.tabId ? visualizeCardThumbnailLine(call, version) : '',
    visualizeCardLiveThumbnail(tab, version),
    tabId && version ? () => readVisualizeVersionThumbnail(sessionId, tabId, version) : undefined
  );
  const kind = visualizeCardKind(call, tab);
  const Icon = KIND_ICONS[kind.kind];
  const problems = tab?.problems?.length ?? 0;
  const title =
    tab?.label ||
    call.label ||
    call.content?.title ||
    (call.content ? visualizeInlineKindLabel(call.content.kind) : call.targets.join(', '));
  const panelOnScreen = useVisualizePanelOnScreen(sessionId);
  const shown = Boolean(tab && newest && panelOnScreen && state.active === tab.id);
  // The picture carries only "New" and "Version N": a newer version already
  // says it was updated, so no status words (showing, updated, closed).
  const badgeLabel = t('Preview badge: New');
  const versionLabel = version ? `${t('Version')} ${version}` : '';
  return (
    <button
      type="button"
      aria-label={versionLabel ? `${title}, ${versionLabel}` : title}
      aria-current={shown ? 'true' : undefined}
      className={`transcript-visualize-tile${closed ? ' is-closed' : ''}${shown ? ' is-shown' : ''}`}
      title={closed ? t('Open again in the side panel') : t('Show in the side panel')}
      data-visualize-card={tileState(closed, newest)}
      data-badge={call.badge}
      data-visualize-tab={call.tabId}
      data-version={version || undefined}
      data-kind={kind.kind}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onOpen(call)}
    >
      <span className="transcript-visualize-thumb" aria-hidden="true">
        {thumbnail ? (
          <img src={thumbnail} alt="" draggable={false} />
        ) : (
          // Never a blank box: the kind's icon on a tint of the title's own.
          <span
            className="transcript-visualize-monogram"
            style={{ '--monogram-hue': monogramHue(title) } as CSSProperties}
          >
            <Icon size={22} strokeWidth={1.8} />
          </span>
        )}
        {call.badge ? (
          <span className={`transcript-visualize-badge is-mark is-${call.badge}`}>{badgeLabel}</span>
        ) : null}
        {version ? (
          <span className="transcript-visualize-badge is-version">
            <span className="transcript-visualize-version-word">{t('Version')} </span>
            {version}
          </span>
        ) : null}
        {problems ? (
          <span className="transcript-visualize-badge is-problem" title={t('Page problems')}>
            <AlertTriangle size={12} aria-hidden="true" />
            {problems}
          </span>
        ) : null}
      </span>
      <b className="transcript-visualize-name" title={title}>
        {title}
      </b>
    </button>
  );
}

/** The turn's one card, in the changed-files card's frame: a header (icon,
 *  "Previews N", the turn's Undo when it stands in for the changes, and
 *  "Show all") over a grid of tiles, one per panel tab on its final version. */
function VisualizeTurnCard({
  calls,
  sessionId,
  compact = false,
  undo,
}: {
  calls: readonly VisualizeCardCall[];
  sessionId: string;
  /** Agent mode: the same card in the bubble column, at its width. */
  compact?: boolean;
  /** The turn's Undo, when this card stands in for every file the turn changed. */
  undo?: ReactNode;
}) {
  const [error, setError] = useState('');
  const run = (list: readonly VisualizeCardCall[]) => {
    setError('');
    void (async () => {
      for (const call of list) await openCall(sessionId, call);
    })().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  // Every tab of the turn comes up, the first one shown last.
  const showAll = () => run([...calls].reverse());
  const count = t('Previews {{n}}', { n: calls.length });
  const [page, setPage] = useState(0);
  const view = turnPreviewPage(calls, page);
  return (
    <section
      className={`transcript-visualize-turn${compact ? ' is-compact' : ''}`}
      aria-label={count}
      data-artifact="visualize"
      data-visualize-count={calls.length}
    >
      <div className="transcript-visualize-head">
        <span className="transcript-visualize-icon" aria-hidden="true">
          <LayoutGrid size={14} />
        </span>
        <strong className="transcript-visualize-title">{count}</strong>
        <span className="transcript-visualize-trail">
          {undo}
          <button
            type="button"
            className="transcript-visualize-all"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={showAll}
          >
            {t('Show all')}
          </button>
        </span>
      </div>
      <div className="transcript-visualize-tiles">
        {view.items.map((call) => (
          <VisualizeTile key={call.id} call={call} sessionId={sessionId} onOpen={(one) => run([one])} />
        ))}
      </div>
      {view.pages > 1 ? (
        <div className="transcript-visualize-pager">
          <button
            type="button"
            className="transcript-visualize-page"
            aria-label={t('Previous page')}
            disabled={view.page === 0}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setPage(view.page - 1)}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <span className="transcript-visualize-page-label">
            {view.page + 1} / {view.pages}
          </span>
          <button
            type="button"
            className="transcript-visualize-page"
            aria-label={t('Next page')}
            disabled={view.page === view.pages - 1}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setPage(view.page + 1)}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {error ? <span className="transcript-visualize-error">{error}</span> : null}
    </section>
  );
}
/** The conversation whose panel holds `sessionId`'s visualize tabs (see
 *  `visualizeOwnerSessionId`): the owner the host stamped on `calls`, else
 *  the agent pool, followed as it changes. */
function useVisualizeOwnerSession(sessionId: string, calls: readonly VisualizeCardCall[]): string {
  const pool = agentPoolStore(globalThis.window?.mixdogDesktop);
  const rows = useSyncExternalStore(pool.subscribe, pool.getSnapshot, pool.getSnapshot);
  return useMemo(() => visualizeOwnerSessionId(sessionId, rows ?? [], calls), [sessionId, rows, calls]);
}

/** Under a tool group: one card per panel tab its `visualize` opens showed. */
export function ToolVisualizeCards({
  items,
  sessionId: transcriptSessionId,
  compact = false,
  frame,
  turnKey = '',
  turnChanges,
  replyText = '',
  surfacedBefore = NO_SURFACED,
  endTurnKey = '',
  endedAt = 0,
}: {
  /** Files earlier turns linked or opened: a change to one is an artifact
   *  even when this turn does not link it again. */
  surfacedBefore?: readonly string[];
  /** The turn's changed-files card: when every file it changed is shown by
   *  these cards, that card is not drawn and the last card carries its Undo. */
  turnChanges?: TurnChangesRef;
  items: readonly TranscriptItem[];
  sessionId: string;
  /** Agent mode's cards in the bubble column (VisualizeCard `compact`). */
  compact?: boolean;
  /** Seats the cards (agent mode: a chat row); nothing renders without cards. */
  frame?: (cards: ReactNode) => ReactNode;
  /** The turn of these items (coding mode's tool groups): a tab opened again
   *  in a later group of the same turn has its one card there. */
  turnKey?: string;
  /** The turn's final reply: a changed file it names is opened at the end. */
  replyText?: string;
  /** The turn this card ends (its rows' turn key): its end, when seen
   *  running here, opens its previews. */
  endTurnKey?: string;
  /** When the turn's last row was recorded (ms): its previews' time when it
   *  ran no tool round. */
  endedAt?: number;
}) {
  const all = useMemo(() => visualizeCardCalls(items), [items]);
  // A sub-agent's or room member's opens and previews live in the panel of
  // the conversation it works for: its cards read their tabs (and its turn)
  // there, and open its previews there.
  const scope = useVisualizeOwnerSession(transcriptSessionId, all);
  // A card appears once, when the turn's end reveals its tab, already on the
  // final version: none is drawn (or redrawn per edit) while the turn runs,
  // and an open still running is not a card yet.
  const heldSince = useVisualizeHeldSince(scope);
  const opened = useMemo(() => visualizedTargets(items), [items]);
  const agentCalls = useMemo(() => visualizeCardsShown(all, heldSince), [all, heldSince]);
  const previews = useTurnPreviews({
    sessionId: scope,
    items,
    opened,
    agentOpens: agentCalls.length > 0,
    turnChanges,
    replyText,
    surfacedBefore,
    heldSince,
    endTurnKey,
    endedAt,
  });
  const sessionId = scope;
  const calls = useMemo(
    () => (previews.calls.length ? [...agentCalls, ...previews.calls] : agentCalls),
    [agentCalls, previews.calls]
  );
  const superseded = useSyncExternalStore(
    subscribeVisualizeCards,
    () =>
      calls
        .filter((call) => visualizeCardSupersededInTurn(sessionId, turnKey, call))
        .map((call) => call.id)
        .join('\n'),
    () => ''
  );
  // After render: noting a newer card re-renders the earlier ones (on their
  // own versions, or gone when the same turn opened the tab again).
  useEffect(() => {
    noteVisualizeTurnCards(sessionId, turnKey, calls);
    noteVisualizeCards(sessionId, calls);
  }, [sessionId, turnKey, calls]);
  const kept = superseded ? calls.filter((call) => !superseded.split('\n').includes(call.id)) : calls;
  const shown = useMemo(() => kept.map(previews.marked), [kept, previews.marked]);
  if (!sessionId || !shown.length) return null;
  const cards = (
    <VisualizeTurnCard
      calls={shown}
      sessionId={sessionId}
      compact={compact}
      undo={turnChanges ? <TurnChangesUndo turnChanges={turnChanges} visualized={previews.visualized} /> : undefined}
    />
  );
  return frame ? frame(cards) : cards;
}

const NO_CHANGED_FILES: readonly TurnChangesFile[] = [];
const NO_SURFACED: readonly string[] = [];
const NO_PREVIEW_CALLS: readonly VisualizeCardCall[] = [];

/** The turn's preview tiles once it ended (turn-preview-model.ts): its
 *  changed files the panel can show that the agent did not open, read from
 *  the turn's change record; `marked` badges every tile by that record, and
 *  `visualized` is every file the card shows (its changed-files card lists
 *  none of them). The turn's end, when this renderer saw it run, opens the
 *  confident ones once. */
function useTurnPreviews({
  sessionId,
  items,
  opened,
  agentOpens,
  turnChanges,
  replyText,
  surfacedBefore,
  heldSince,
  endTurnKey,
  endedAt,
}: {
  sessionId: string;
  items: readonly TranscriptItem[];
  opened: readonly string[];
  /** The agent opened tabs this turn: its previews open without being
   *  shown, so the panel ends on the agent's own last open. */
  agentOpens: boolean;
  turnChanges?: TurnChangesRef;
  replyText: string;
  surfacedBefore: readonly string[];
  heldSince: number | null;
  endTurnKey: string;
  endedAt: number;
}) {
  const surface = useContext(TurnChangesContext);
  const changesSession = turnChanges ? (surface?.sessionId ?? '') : '';
  const checkpointId = turnChanges?.checkpointId ?? '';
  const running = Boolean(turnChanges?.trailing && surface?.turnRunning);
  const { reply } = useTurnChanges({
    sessionId: changesSession,
    checkpointId,
    boundary: turnChanges?.boundary ?? '',
    enabled: Boolean(changesSession && checkpointId) && !running,
  });
  // Nothing new appears while the turn runs.
  const ready = Boolean(changesSession) && !running && reply?.status === 'ready';
  const files = ready && reply ? reply.files : NO_CHANGED_FILES;
  const root = ready && reply ? reply.root : '';
  const state = useVisualizeState(sessionId);
  // Surfaced earlier: linked or opened by earlier turns (the transcript), or
  // shown by a panel tab now (the host's state). Keyed by content: the caller
  // builds the list afresh on every render.
  const surfacedKey = [...surfacedBefore, ...state.tabs.flatMap((tab) => tab.panes.map((pane) => pane.target))].join(
    '\n'
  );
  const found = useMemo(
    () => turnPreviewFiles(files, root, opened, replyText, surfacedKey ? surfacedKey.split('\n') : []),
    [files, root, opened, replyText, surfacedKey]
  );
  const at = useMemo(() => Math.max(visualizeTurnEndAt(items), endedAt), [items, endedAt]);
  const calls = useMemo(() => {
    if (!found.length) return NO_PREVIEW_CALLS;
    return found.map(
      (file): VisualizeCardCall => ({
        id: `preview:${checkpointId}:${file.path}`,
        pending: false,
        targets: [file.target],
        label: previewFileLabel(file.path),
        tabId: visualizeTabForTargets(state, [file.target])?.id ?? '',
        at,
        preview: true,
        ...(file.badge ? { badge: file.badge } : {}),
      })
    );
  }, [found, state, at, checkpointId]);
  const marked = useCallback(
    (call: VisualizeCardCall): VisualizeCardCall => {
      if (call.preview || !files.length) return call;
      const badge = turnPreviewBadgeFor(call.targets, files, root);
      return badge ? { ...call, badge } : call;
    },
    [files, root]
  );
  const targets = useMemo(() => found.map((file) => file.target), [found]);
  const visualized = useMemo(() => (targets.length ? [...opened, ...targets] : opened), [opened, targets]);
  useEffect(() => {
    noteTurnPreviewTargets(changesSession, checkpointId, targets);
  }, [changesSession, checkpointId, targets]);
  // The live turn end: the trailing card drawn once its turn stopped claims
  // the running mark of that very turn (other turns, history, reconnects and
  // re-renders find none),
  // then opens its confident previews once its changes are known and the
  // panel's turn hold has released (the agent's own opens shown first).
  const trailingEnd = Boolean(turnChanges?.trailing && changesSession) && !running;
  useEffect(() => {
    if (trailingEnd) claimTurnPreviewEnd(changesSession, endTurnKey, checkpointId);
  }, [trailingEnd, changesSession, endTurnKey, checkpointId]);
  const settled = Boolean(reply) && !running && heldSince === null;
  useEffect(() => {
    if (!settled || !turnPreviewOpenPending(changesSession, checkpointId)) return;
    takeTurnPreviewOpen(changesSession, checkpointId);
    const order = turnPreviewOpenOrder(found);
    if (order.length) void openTurnPreviews(sessionId, order, { reveal: !agentOpens });
  }, [settled, changesSession, checkpointId, found, sessionId, agentOpens]);
  return { calls, marked, visualized };
}

/** The turn's changed-files card, listing none of the files its preview card
 *  shows (the agent's opens, `visualized`, and the turn's previews). */
export function PreviewedTurnChangesCard({
  turnChanges,
  frame,
  visualized,
}: {
  turnChanges: TurnChangesRef;
  frame?: (card: ReactNode) => ReactNode;
  visualized?: readonly string[];
}) {
  const surface = useContext(TurnChangesContext);
  const sessionId = surface?.sessionId ?? '';
  const previews = useSyncExternalStore(
    subscribeTurnPreviews,
    () => turnPreviewTargets(sessionId, turnChanges.checkpointId),
    () => turnPreviewTargets(sessionId, turnChanges.checkpointId)
  );
  const shown = useMemo(
    () => (previews.length ? [...(visualized ?? []), ...previews] : visualized),
    [visualized, previews]
  );
  return <TurnChangesCard turnChanges={turnChanges} frame={frame} visualized={shown} />;
}
