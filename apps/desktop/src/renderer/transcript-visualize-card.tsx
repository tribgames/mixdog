import { AlertTriangle, ChartColumn, FileCode, FileText, Film, Image, LayoutGrid, Music, Shapes, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';

import { visualizeThumbnail } from '../shared/visualize';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { TextShimmer } from './transcript-primitives';
import {
  type VisualizeCardCall,
  visualizeCardCalls,
  visualizeCardKind,
  visualizeCardTab,
  visualizeCardVersion,
  visualizeInlineKindLabel,
} from './visualize-card-model';
import {
  reopenVisualizeContent,
  reopenVisualizeTargets,
  revealVisualizeTab,
  useVisualizeState,
} from './visualize-store';

function KindIcon({ kind }: { kind: ReturnType<typeof visualizeCardKind> }) {
  const size = 18;
  switch (kind) {
    case 'html':
      return <FileCode size={size} />;
    case 'image':
      return <Image size={size} />;
    case 'video':
      return <Film size={size} />;
    case 'audio':
      return <Music size={size} />;
    case 'split':
      return <LayoutGrid size={size} />;
    case 'mermaid':
      return <Workflow size={size} />;
    case 'chart':
      return <ChartColumn size={size} />;
    case 'svg':
      return <Shapes size={size} />;
    default:
      return <FileText size={size} />;
  }
}

function VisualizeCard({ call, sessionId }: { call: VisualizeCardCall; sessionId: string }) {
  const state = useVisualizeState(sessionId);
  const [error, setError] = useState('');
  const tab = visualizeCardTab(state, call);
  const kind = visualizeCardKind(call, tab);
  // Inline content has no files to name: its kind stands in under the title.
  const targets = call.content ? visualizeInlineKindLabel(call.content.kind) : call.targets.join(', ');
  if (call.pending) {
    return (
      <div className="transcript-visualize-card is-pending" data-visualize-card="pending">
        <span className="transcript-visualize-thumb" aria-hidden="true">
          <KindIcon kind={kind} />
        </span>
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
  const thumbnail = visualizeThumbnail(tab?.thumbnail);
  const version = visualizeCardVersion(tab);
  const problems = tab?.problems?.length ?? 0;
  const title = tab?.label || call.label || call.content?.title || targets;
  const open = () => {
    setError('');
    if (tab) {
      revealVisualizeTab(sessionId, tab.id);
      return;
    }
    const reopened = call.content
      ? reopenVisualizeContent(sessionId, call.tabId, call.content, call.label)
      : reopenVisualizeTargets(sessionId, call.tabId, call.targets, call.label);
    reopened.catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason))
    );
  };
  return (
    <div className="transcript-visualize-card-wrap">
      <button
        type="button"
        className={`transcript-visualize-card${thumbnail ? ' has-thumbnail' : ''}${closed ? ' is-closed' : ''}`}
        data-visualize-card={closed ? 'closed' : 'open'}
        title={closed ? t('Open again in the side panel') : t('Show in the side panel')}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={open}
      >
        <span className="transcript-visualize-thumb" aria-hidden="true">
          {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : <KindIcon kind={kind} />}
        </span>
        <span className="transcript-visualize-copy">
          <b>{title}</b>
          <small title={targets}>{targets}</small>
        </span>
        <span className="transcript-visualize-badges">
          {version ? <span className="transcript-visualize-badge">{version}</span> : null}
          {problems ? (
            <span className="transcript-visualize-badge is-problem" title={t('Page problems')} aria-label={t('Page problems')}>
              <AlertTriangle size={12} aria-hidden="true" />
              {problems}
            </span>
          ) : null}
          {closed ? <span className="transcript-visualize-badge is-closed">{t('Closed')}</span> : null}
        </span>
      </button>
      {error ? <span className="transcript-visualize-error">{error}</span> : null}
    </div>
  );
}

/** Under a tool group: one card per panel tab its `visualize` opens showed —
 *  a picture of the tab, its label, version and page problems. A press shows
 *  the tab in the session's panel, or opens the same files again once the tab
 *  was closed. Remote clients draw the same card from their mirrored state. */
export function ToolVisualizeCards({ items, sessionId }: { items: readonly TranscriptItem[]; sessionId: string }) {
  const calls = useMemo(() => visualizeCardCalls(items), [items]);
  if (!sessionId || !calls.length) return null;
  return (
    <div className="transcript-visualize-cards">
      {calls.map((call) => (
        <VisualizeCard key={call.id} call={call} sessionId={sessionId} />
      ))}
    </div>
  );
}
