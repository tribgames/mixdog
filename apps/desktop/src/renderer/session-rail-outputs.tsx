// The session panel's Outputs category: what the session showed in its
// visualize tabs, newest first, one row each. A row opens its output in the
// side panel; its X closes that tab.
import {
  AppWindow,
  BarChart3,
  Columns3,
  FileText,
  Image,
  type LucideIcon,
  Music,
  PenTool,
  Video,
  Workflow,
  X,
} from 'lucide-react';
import type { VisualizeSessionState, VisualizeTabView } from '../shared/visualize';
import { t, uiFormatLocale } from './i18n';
import { RailSection } from './session-rail-parts';
import { useClock } from './use-clock';
import { type VisualizeCardKind, visualizeCardKind } from './visualize-card-model';
import {
  closeVisualizeTab,
  revealVisualizeTab,
  useVisualizePanelOnScreen,
  useVisualizeState,
  useVisualizeUpdatedTabs,
  visualizeTabTooltip,
  visualizeVersionPosition,
} from './visualize-store';
import './session-rail-outputs.css';

const KIND_ICONS: Record<VisualizeCardKind, LucideIcon> = {
  html: AppWindow,
  image: Image,
  svg: PenTool,
  markdown: FileText,
  document: FileText,
  pdf: FileText,
  mermaid: Workflow,
  chart: BarChart3,
  audio: Music,
  video: Video,
  split: Columns3,
};

export type SessionOutput = {
  tab: VisualizeTabView;
  kind: VisualizeCardKind;
  /** The newest kept version, while the tab keeps versions to step through. */
  version: number | null;
  /** When it last changed (ms; 0 when the host does not say). */
  at: number;
};

/** The session's open visualize tabs, newest first. */
export function sessionOutputs(state: VisualizeSessionState): SessionOutput[] {
  const history = state.history ?? [];
  return state.tabs
    .map((tab) => ({
      tab,
      kind: visualizeCardKind({ id: tab.id, pending: false, targets: [], label: tab.label, tabId: tab.id, at: 0 }, tab)
        .kind,
      version: visualizeVersionPosition(tab)?.newest ?? null,
      at: tab.versions?.at(-1)?.at ?? history.find((item) => item.open && item.label === tab.label)?.at ?? 0,
    }))
    .reverse()
    .sort((a, b) => b.at - a.at);
}

/** "Just now", "4m ago", "3h ago", then the day: a point in time, never read as a duration. */
export function sessionOutputAge(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return t('Just now');
  if (minutes < 60) return t('{{time}} ago', { time: t('{{minutes}}m', { minutes }) });
  if (minutes < 24 * 60) return t('{{time}} ago', { time: t('{{hours}}h', { hours: Math.floor(minutes / 60) }) });
  return new Date(at).toLocaleDateString(uiFormatLocale(), { month: 'short', day: 'numeric' });
}

export function OutputsSection({ sessionId, open, onToggle }: { sessionId: string; open: boolean; onToggle(): void }) {
  const state = useVisualizeState(sessionId);
  const updated = useVisualizeUpdatedTabs(sessionId);
  const panelOnScreen = useVisualizePanelOnScreen(sessionId);
  const outputs = sessionOutputs(state);
  const now = useClock(open && outputs.length > 0);
  if (!outputs.length) return null;
  const shownId = panelOnScreen ? state.active : null;
  const unseen = (id: string) => updated.has(id) && id !== shownId;
  const dot = <span className="session-outputs-dot" role="img" aria-label={t('Updated')} title={t('Updated')} />;
  return (
    <RailSection
      category="outputs"
      title={t('Outputs')}
      // At the head's end, as Changes and Git write theirs: the mark of an unseen update, then how many.
      count={
        <span className="session-rail-todo-figure">
          {outputs.some(({ tab }) => unseen(tab.id)) ? dot : null}
          <span>{outputs.length}</span>
        </span>
      }
      open={open}
      onToggle={onToggle}
      scroll
    >
      {outputs.map(({ tab, kind, version, at }) => {
        const Icon = KIND_ICONS[kind];
        return (
          <div
            key={tab.id}
            className="session-rail-row session-outputs-row"
            data-kind={kind}
            data-selected={tab.id === shownId || undefined}
          >
            <button
              type="button"
              className="session-outputs-open"
              title={visualizeTabTooltip(tab)}
              aria-current={tab.id === shownId || undefined}
              onClick={() => revealVisualizeTab(sessionId, tab.id)}
            >
              <Icon size={16} className="session-rail-ic" aria-hidden="true" />
              <span className="session-rail-cut session-outputs-name">{tab.label}</span>
              {version !== null && <span className="session-rail-num session-outputs-version">v{version}</span>}
              <span className="session-outputs-state">
                {unseen(tab.id) && dot}
                {at > 0 && (
                  <time className="session-rail-num" dateTime={new Date(at).toISOString()}>
                    {sessionOutputAge(at, now)}
                  </time>
                )}
              </span>
            </button>
            <button
              type="button"
              className="session-outputs-close"
              aria-label={t('Close tab')}
              title={t('Close tab')}
              onClick={() => closeVisualizeTab(sessionId, tab.id)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </RailSection>
  );
}
