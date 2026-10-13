// The visualize panel's session list ("All visuals"), per-tab source toggle
// and export menu, kept out of VisualizePane so the pane stays the layout:
// one hook returns the toolbar actions and the strips drawn under the header.
import { Code, Download, LayoutList, Save, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import type { VisualizeHistoryItem, VisualizePaneView, VisualizeSessionState } from '../shared/visualize';
import { t } from './i18n';
import { type DockAction } from './pane-dock-chrome';
import { downloadBlob, visualizePaneHasSource, visualizeSourceFileName } from './visualize-source';
import {
  exportVisualizeTab,
  openVisualizeHistory,
  reopenVisualizeTargets,
  visualizeExportPane,
  visualizeHistoryTime,
} from './visualize-store';

type Tab = VisualizeSessionState['tabs'][number];

interface Notice {
  error: boolean;
  text: string;
  /** A project-relative file the notice offers to open as a tab. */
  open?: string;
}

/** "v3": the number of versions an entry kept (not a sentence to translate). */
const versionTag = (count: number): string => 'v'.concat(String(count));

/** The reason of a failed command, without Electron's "Error invoking remote
 *  method '…': Error:" wrapper. */
const messageOf = (reason: unknown): string =>
  (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');

/** Download pane `index` to this device (paired remote clients): inline
 *  content and HTML pages as text, everything else as the bytes the pane
 *  loads. */
async function downloadPane(sessionId: string, tabId: string, index: number, pane: VisualizePaneView): Promise<void> {
  const api = window.mixdogDesktop;
  if (pane.inline) {
    downloadBlob(new Blob([pane.inline.source], { type: 'text/plain' }), visualizeSourceFileName(pane));
    return;
  }
  const source = await api?.visualizePaneSource?.(sessionId, tabId, index);
  if (source?.srcdoc !== undefined) {
    downloadBlob(new Blob([source.srcdoc], { type: 'text/html' }), visualizeSourceFileName({ label: pane.label }));
    return;
  }
  if (!source?.url) throw new Error(t('Source unavailable'));
  try {
    const blob = await (await fetch(source.url)).blob();
    // An Office document is served as its PDF conversion.
    downloadBlob(blob, pane.kind === 'document' ? `${pane.label}.pdf` : pane.label);
  } finally {
    URL.revokeObjectURL(source.url);
  }
}

function HistoryList({
  items,
  onPick,
}: {
  items: VisualizeHistoryItem[];
  onPick(item: VisualizeHistoryItem): void;
}) {
  return (
    <ul className="visualize-history" aria-label={t('All visuals')}>
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" className={`visualize-history-item${item.open ? ' is-open' : ''}`} onClick={() => onPick(item)}>
            <span className="visualize-history-kind">{item.kind}</span>
            <span className="visualize-history-label">{item.label}</span>
            {item.versions > 1 ? <span className="visualize-history-versions">{versionTag(item.versions)}</span> : null}
            <time className="visualize-history-time" dateTime={new Date(item.at).toISOString()}>
              {visualizeHistoryTime(item.at)}
            </time>
            <span className="visualize-history-state">{item.open ? t('Open') : t('Closed')}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Toolbar actions and strips for the active `tab` (null = none open). */
export function useVisualizePanelExtras(
  sessionId: string,
  state: VisualizeSessionState,
  tab: Tab | null,
  remote: boolean
): { actions: DockAction[]; strips: ReactNode; sourceOn: boolean } {
  const tabId = tab?.id ?? '';
  const [sourceTabs, setSourceTabs] = useState<ReadonlySet<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: session and tab are the reset triggers
  useEffect(() => setNotice(null), [sessionId, tabId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger
  useEffect(() => setHistoryOpen(false), [sessionId]);

  const sourceKey = `${sessionId}\0${tabId}`;
  const sourceOn = tab !== null && sourceTabs.has(sourceKey);
  const actions: DockAction[] = [];
  if (state.history) {
    actions.push({
      id: 'history',
      label: t('All visuals'),
      icon: LayoutList,
      inline: true,
      checked: historyOpen,
      onSelect: () => setHistoryOpen(!historyOpen),
    });
  }
  if (tab?.panes.some(visualizePaneHasSource)) {
    actions.push({
      id: 'source',
      label: t('Source'),
      icon: Code,
      inline: true,
      checked: sourceOn,
      onSelect: () =>
        setSourceTabs((current) => {
          const next = new Set(current);
          if (!next.delete(sourceKey)) next.add(sourceKey);
          return next;
        }),
    });
  }

  const index = tab ? visualizeExportPane(tab) : 0;
  const pane = tab?.panes[index];
  const run = (task: Promise<unknown>) => task.catch((reason: unknown) => setNotice({ error: true, text: messageOf(reason) }));
  const exportTo = (format: 'png' | 'pdf' | 'project') => {
    // The render after the save dialog takes a moment: say so, and never
    // leave an earlier notice standing for a finished or canceled export.
    setNotice(format === 'project' ? null : { error: false, text: t('Exporting…') });
    return run(
      exportVisualizeTab(sessionId, tabId, format, index).then((result) => {
        if (result?.canceled) {
          setNotice(null);
          return;
        }
        if (!result?.path) throw new Error(t('The export did not produce a file'));
        const path = format === 'project' ? result.path : (result.path.split(/[\\/]/).pop() ?? result.path);
        setNotice({
          error: false,
          text: t('Saved to {{path}}', { path }),
          ...(format === 'project' && result.openable ? { open: result.path } : {}),
        });
      })
    );
  };
  if (tab && pane) {
    if (remote) {
      actions.push({
        id: 'download',
        label: t('Download'),
        icon: Download,
        onSelect: () => void run(downloadPane(sessionId, tabId, index, pane)),
      });
    } else {
      actions.push({ id: 'export-png', label: t('Save as PNG'), icon: Download, onSelect: () => void exportTo('png') });
      if (pane.kind === 'html') {
        actions.push({ id: 'export-pdf', label: t('Save as PDF'), icon: Download, onSelect: () => void exportTo('pdf') });
      }
    }
    if (pane.inline) {
      actions.push({ id: 'export-project', label: t('Save to project'), icon: Save, onSelect: () => void exportTo('project') });
    }
  }

  const strips = (
    <>
      {historyOpen && state.history ? (
        <HistoryList
          items={state.history}
          onPick={(item) => {
            setHistoryOpen(false);
            void run(openVisualizeHistory(sessionId, item.id));
          }}
        />
      ) : null}
      {notice ? (
        <div className={`visualize-notice${notice.error ? ' is-error' : ''}`} role="status">
          <span className="visualize-notice-text">{notice.text}</span>
          {notice.open ? (
            <button
              type="button"
              className="visualize-version-action"
              onClick={() => {
                const file = notice.open as string;
                setNotice(null);
                void run(reopenVisualizeTargets(sessionId, tabId, [file], ''));
              }}
            >
              {t('Open')}
            </button>
          ) : null}
          <button
            type="button"
            className="visualize-notice-dismiss"
            aria-label={t('Dismiss')}
            data-tooltip={t('Dismiss')}
            onClick={() => setNotice(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
  return { actions, strips, sourceOn };
}
