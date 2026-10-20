// The chat card of a `visualize` open, one row: the picture of its version
// (taken when its turn ended; the kind's icon without one), its title, kind
// and version, where it is (shown in the panel, updated behind another tab,
// an earlier version, closed), page problems, and one button that shows the
// tab on the card's version in the session's side panel — or opens it again
// once closed. Coding mode draws it under the tool group, agent mode in the
// bubble column. Remote clients draw the same card from their mirrored state.
import {
  AlertTriangle,
  BarChart3,
  CodeXml,
  Columns3,
  FileText,
  FileType,
  Image,
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
  visualizeCardKindLabel,
  visualizeCardLiveThumbnail,
  visualizeCardNewest,
  visualizeCardOwnVersion,
  visualizeCardSupersededInTurn,
  visualizeCardsShown,
  visualizeCardTab,
  visualizeCardThumbnailLine,
  visualizeCardVersion,
  visualizeInlineKindLabel,
} from './visualize-card-model';
import {
  readVisualizeVersionThumbnail,
  reopenVisualizeContent,
  reopenVisualizeTargets,
  revealVisualizeTab,
  showVisualizeVersion,
  useVisualizeState,
  useVisualizeHeldSince,
  useVisualizeUpdatedTabs,
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

function VisualizeCard({
  call,
  sessionId,
  compact = false,
}: {
  call: VisualizeCardCall;
  sessionId: string;
  /** Agent mode: the same card in the bubble column, at its width. */
  compact?: boolean;
}) {
  // Drawn only once the turn ended (ToolVisualizeCards): the tab as revealed.
  const state = useVisualizeState(sessionId);
  const updatedTabs = useVisualizeUpdatedTabs(sessionId);
  const newest = useSyncExternalStore(
    subscribeVisualizeCards,
    () => visualizeCardNewest(sessionId, call),
    () => true
  );
  const [error, setError] = useState('');
  const tab = visualizeCardTab(state, call);
  const closed = tab === null;
  // The newest card follows its tab; an earlier one keeps the version its
  // own turn ended on.
  // (An open that named no version on a tab that keeps them made its first.)
  const version =
    visualizeCardOwnVersion(sessionId, call, visualizeCardVersion(tab), newest) || (tab?.versions?.length ? 1 : 0);
  // The picture of this card's own version, taken when its turn ended: from
  // the tab while it has it, else the copy saved under that version (a closed
  // card, an earlier one, a restart), else asked of the host once.
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
  const meta = [visualizeCardKindLabel(kind), version ? `${t('Version')} ${version}` : ''].filter(Boolean).join(' · ');
  // The tab on this card's version: an earlier card shows the version its
  // turn ended on, the newest goes back to live.
  const open = () => {
    setError('');
    if (tab) {
      revealVisualizeTab(sessionId, tab.id);
      const live = tab.versions?.at(-1)?.n;
      const target = !newest && version && version !== live ? version : null;
      if ((tab.version ?? null) !== target) showVisualizeVersion(sessionId, tab.id, target);
      return;
    }
    const reopened = call.content
      ? reopenVisualizeContent(sessionId, call.tabId, call.content, call.label)
      : reopenVisualizeTargets(sessionId, call.tabId, call.targets, call.label);
    reopened.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const button = (
    <button
      type="button"
      className="transcript-visualize-open"
      title={closed ? t('Open again in the side panel') : t('Show in the side panel')}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={open}
    >
      {closed ? t('Open again') : t('View')}
    </button>
  );
  return (
    <div className="transcript-visualize-card-wrap">
      <div
        className={`transcript-visualize-card${compact ? ' is-compact' : ''}${closed ? ' is-closed' : ''}${shown ? ' is-shown' : ''}`}
        data-artifact="visualize"
        data-visualize-card={closed ? 'closed' : newest ? 'open' : 'folded'}
        data-visualize-tab={call.tabId}
        data-version={version || undefined}
        data-kind={kind.kind}
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
        </span>
        <span className="transcript-visualize-copy">
          <b title={title}>{title}</b>
          <small title={meta}>
            {meta}
            {status ? <span className="transcript-visualize-status"> · {status}</span> : null}
          </small>
        </span>
        {problems ? (
          <span className="transcript-visualize-badge is-problem" title={t('Page problems')}>
            <AlertTriangle size={12} aria-hidden="true" />
            {problems}
          </span>
        ) : null}
        {button}
      </div>
      {error ? <span className="transcript-visualize-error">{error}</span> : null}
    </div>
  );
}

/** Under a tool group: one card per panel tab its `visualize` opens showed. */
export function ToolVisualizeCards({
  items,
  sessionId,
  compact = false,
  frame,
  turnKey = '',
}: {
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
    <div className="transcript-visualize-cards">
      {shown.map((call) => (
        <VisualizeCard key={call.id} call={call} sessionId={sessionId} compact={compact} />
      ))}
    </div>
  );
  return frame ? frame(cards) : cards;
}
