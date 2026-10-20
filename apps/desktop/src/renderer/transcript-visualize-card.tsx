// The chat card of a turn's `visualize` opens: ONE card per Lead turn, stamped
// under the reply once the turn ended (like the changed-files card) on each
// tab's final version. A tile per distinct panel tab: the picture of its
// version, its title, version and where it is (shown in the panel, updated
// behind another tab, an earlier version, closed); a tile shows its tab in
// the session's side panel (or opens it again once closed), "Show all" brings
// every tab of the turn up. Coding mode draws it under the reply, agent mode
// in the bubble column. Remote clients draw it from their mirrored state.
import {
  AlertTriangle,
  BarChart3,
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
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { usePersistedThumbnail } from './persisted-thumbnail';
import {
  monogramHue,
  noteVisualizeCards,
  noteVisualizeTurnCards,
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
  visualizeInlineKindLabel,
  visualizedTargets,
} from './visualize-card-model';
import { TurnChangesUndo } from './TurnChangesCard';
import type { TurnChangesRef } from './turn-changes-model';
import type { VisualizeTabView } from '../shared/visualize';
import {
  readVisualizeVersionThumbnail,
  reopenVisualizeContent,
  reopenVisualizeTargets,
  revealVisualizeTab,
  showVisualizeVersion,
  useVisualizeState,
  useVisualizeHeldSince,
  useVisualizeUpdatedTabs,
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
  return visualizeCardOwnVersion(sessionId, call, visualizeCardVersion(tab), newest) || (tab?.versions?.length ? 1 : 0);
}

/** Show the call's tab on the card's version in the side panel, or open it
 *  again when it was closed (no agent turn). */
function openCall(sessionId: string, call: VisualizeCardCall): Promise<void> {
  const tab = visualizeCardTab(visualizeStateFor(sessionId), call);
  if (tab) {
    const newest = visualizeCardNewest(sessionId, call);
    const version = cardVersion(sessionId, call, tab, newest);
    revealVisualizeTab(sessionId, tab.id);
    const live = tab.versions?.at(-1)?.n;
    const target = !newest && version && version !== live ? version : null;
    if ((tab.version ?? null) !== target) showVisualizeVersion(sessionId, tab.id, target);
    return Promise.resolve();
  }
  return call.content
    ? reopenVisualizeContent(sessionId, call.tabId, call.content, call.label)
    : reopenVisualizeTargets(sessionId, call.tabId, call.targets, call.label);
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
  const updatedTabs = useVisualizeUpdatedTabs(sessionId);
  const newest = useSyncExternalStore(
    subscribeVisualizeCards,
    () => visualizeCardNewest(sessionId, call),
    () => true
  );
  const tab = visualizeCardTab(state, call);
  const closed = tab === null;
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
  const shown = Boolean(tab && newest && state.active === tab.id);
  let status = '';
  if (closed) status = t('Closed');
  else if (!newest) status = t('Earlier version');
  else if (updatedTabs.has(call.tabId)) status = t('Updated');
  else if (shown) status = t('Showing');
  const meta = [version ? `${t('Version')} ${version}` : '', status].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      className={`transcript-visualize-tile${closed ? ' is-closed' : ''}${shown ? ' is-shown' : ''}`}
      title={closed ? t('Open again in the side panel') : t('Show in the side panel')}
      data-visualize-card={closed ? 'closed' : newest ? 'open' : 'folded'}
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
        {problems ? (
          <span className="transcript-visualize-badge is-problem" title={t('Page problems')}>
            <AlertTriangle size={12} aria-hidden="true" />
            {problems}
          </span>
        ) : null}
      </span>
      <b title={title}>{title}</b>
      <small title={meta}>
        {version ? `${t('Version')} ${version}` : ''}
        {status ? (
          <span className="transcript-visualize-status">
            {version ? ' · ' : ''}
            {status}
          </span>
        ) : null}
      </small>
    </button>
  );
}

/** The turn's one card, in the changed-files card's frame: a header (icon,
 *  "Visualizations N", the turn's Undo when it stands in for the changes, and
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
  const count = t('Visualizations {{n}}', { n: calls.length });
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
        {calls.map((call) => (
          <VisualizeTile key={call.id} call={call} sessionId={sessionId} onOpen={(one) => run([one])} />
        ))}
      </div>
      {error ? <span className="transcript-visualize-error">{error}</span> : null}
    </section>
  );
}
/** Under a tool group: one card per panel tab its `visualize` opens showed. */
export function ToolVisualizeCards({
  items,
  sessionId,
  compact = false,
  frame,
  turnKey = '',
  turnChanges,
}: {
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
}) {
  // A card appears once, when the turn's end reveals its tab, already on the
  // final version: none is drawn (or redrawn per edit) while the turn runs,
  // and an open still running is not a card yet.
  const heldSince = useVisualizeHeldSince(sessionId);
  const all = useMemo(() => visualizeCardCalls(items), [items]);
  const calls = useMemo(() => visualizeCardsShown(all, heldSince), [all, heldSince]);
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
  const shown = superseded ? calls.filter((call) => !superseded.split('\n').includes(call.id)) : calls;
  if (!sessionId || !shown.length) return null;
  const cards = (
    <VisualizeTurnCard
      calls={shown}
      sessionId={sessionId}
      compact={compact}
      undo={
        turnChanges ? <TurnChangesUndo turnChanges={turnChanges} visualized={visualizedTargets(items)} /> : undefined
      }
    />
  );
  return frame ? frame(cards) : cards;
}
