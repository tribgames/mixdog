// The chat card of a `visualize` open: which artifact it is (title, files or
// kind, the version it shows, page problems), where it is (shown in the
// panel, updated behind another tab, closed) and one button that focuses the
// tab in the session's side panel — or opens it again once closed. The card
// reads the live tab state, so it updates in place; a tab opened again later
// in the transcript keeps one full card (the newest) and the earlier ones
// fold to a line. Remote clients draw the same card from their mirrored state.
import { AlertTriangle } from 'lucide-react';
import { type CSSProperties, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { visualizeThumbnail } from '../shared/visualize';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { MarkdownProjectContext } from './MarkdownLink';
import { useFileSnapshot, usePersistedThumbnail } from './persisted-thumbnail';
import { TextShimmer } from './transcript-primitives';
import {
  monogramHue,
  monogramLetter,
  noteVisualizeCards,
  subscribeVisualizeCards,
  type VisualizeCardCall,
  visualizeCardCalls,
  visualizeCardNewest,
  visualizeCardTab,
  visualizeCardThumbnailLine,
  visualizeCardVersion,
  visualizeInlineKindLabel,
} from './visualize-card-model';
import {
  reopenVisualizeContent,
  reopenVisualizeTargets,
  revealVisualizeTab,
  useVisualizeState,
  useVisualizeUpdatedTabs,
} from './visualize-store';
import './transcript-visualize-card.css';

function VisualizeCard({ call, sessionId }: { call: VisualizeCardCall; sessionId: string }) {
  const state = useVisualizeState(sessionId);
  const updatedTabs = useVisualizeUpdatedTabs(sessionId);
  const newest = useSyncExternalStore(
    subscribeVisualizeCards,
    () => visualizeCardNewest(sessionId, call),
    () => true
  );
  const [error, setError] = useState('');
  const tab = visualizeCardTab(state, call);
  // Inline content has no files to name: its kind stands in under the title.
  const targets = call.content ? visualizeInlineKindLabel(call.content.kind) : call.targets.join(', ');
  // The live tab's snapshot is saved per session + tab + what it shows, so a
  // closed card (or one restored after a restart) keeps its picture.
  const savedThumbnail = usePersistedThumbnail(
    sessionId,
    call.tabId ? visualizeCardThumbnailLine(call) : '',
    visualizeThumbnail(tab?.thumbnail) || undefined
  );
  const renderedThumbnail = useFileSnapshot(
    sessionId,
    useContext(MarkdownProjectContext),
    call.targets[0] ?? '',
    newest && !savedThumbnail && !call.content && !call.pending
  );
  const thumbnail = savedThumbnail || renderedThumbnail;
  if (call.pending) {
    return (
      <div className="transcript-visualize-card is-pending" data-visualize-card="pending">
        <span className="transcript-visualize-copy">
          <b>
            <TextShimmer text={t('Opening…')} />
          </b>
          <small title={targets}>{targets}</small>
        </span>
      </div>
    );
  }
  const closed = tab === null;
  const version = visualizeCardVersion(tab);
  const problems = tab?.problems?.length ?? 0;
  const title = tab?.label || call.label || call.content?.title || targets;
  const shown = Boolean(tab && state.active === tab.id);
  let status = '';
  if (closed) status = t('Closed');
  else if (updatedTabs.has(call.tabId)) status = t('Updated');
  const open = () => {
    setError('');
    if (tab) {
      revealVisualizeTab(sessionId, tab.id);
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
  const meta = [targets, version ? `${t('Version')} ${version}` : ''].filter(Boolean).join(' · ');
  if (!newest) {
    // An earlier open of a tab opened again further down: one line.
    return (
      <div className="transcript-visualize-card is-folded" data-visualize-card="folded" data-visualize-tab={call.tabId}>
        <span className="transcript-visualize-copy">
          <b title={title}>{title}</b>
        </span>
        {button}
      </div>
    );
  }
  return (
    <div className="transcript-visualize-card-wrap">
      <div
        className={`transcript-visualize-card${thumbnail ? ' has-thumbnail' : ''}${closed ? ' is-closed' : ''}${shown ? ' is-shown' : ''}`}
        data-visualize-card={closed ? 'closed' : 'open'}
        data-visualize-tab={call.tabId}
      >
        <span className="transcript-visualize-thumb" aria-hidden="true">
          {thumbnail ? (
            <img src={thumbnail} alt="" draggable={false} />
          ) : (
            // Never a blank box: the page's initial on a tint of its own.
            <span
              className="transcript-visualize-monogram"
              style={{ '--monogram-hue': monogramHue(title) } as CSSProperties}
            >
              {monogramLetter(title)}
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
export function ToolVisualizeCards({ items, sessionId }: { items: readonly TranscriptItem[]; sessionId: string }) {
  const calls = useMemo(() => visualizeCardCalls(items), [items]);
  // After render: noting a newer card re-renders the earlier ones (folded).
  useEffect(() => noteVisualizeCards(sessionId, calls), [sessionId, calls]);
  if (!sessionId || !calls.length) return null;
  return (
    <div className="transcript-visualize-cards">
      {calls.map((call) => (
        <VisualizeCard key={call.id} call={call} sessionId={sessionId} />
      ))}
    </div>
  );
}
