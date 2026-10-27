// The visualize panel's session list ("All visuals"), per-tab source toggle
// and export menu, kept out of VisualizePane so the pane stays the layout:
// one hook returns the toolbar actions and the "All visuals" list drawn under
// the header. Outcomes and errors go to the app toasts, never a strip.
import { Code, Download, ExternalLink, History, LayoutList, Save, Undo2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import type { VisualizeHistoryItem, VisualizePaneView, VisualizeSessionState } from '../shared/visualize';
import { dismissDesktopToast, showDesktopToast } from './desktop-toasts';
import { fileDownloadFailureMessage } from './file-download-transfer';
import { confirmAction } from './app-confirm';
import { t } from './i18n';
import type { DockAction } from './pane-dock-chrome';
import { downloadBlob, visualizePaneHasSource, visualizeSourceFileName } from './visualize-source';
import { downloadVisualizeExport, visualizeRemoteExportAvailable } from './visualize-remote-export';
import {
  exportVisualizeTab,
  openVisualizeHistory,
  reopenVisualizeTargets,
  restoreVisualizeVersion,
  showVisualizeVersion,
  toggleVisualizeCompare,
  visualizeExportPane,
  visualizeHistoryTime,
  visualizeVersionPosition,
} from './visualize-store';

type Tab = VisualizeSessionState['tabs'][number];

interface Notice {
  error: boolean;
  text: string;
}

/** "v3": the number of versions an entry kept (not a sentence to translate). */
const versionTag = (count: number): string => 'v'.concat(String(count));

/** The reason of a failed command, without Electron's "Error invoking remote
 *  method '…': Error:" wrapper (the panel's notices and the chat cards). */
export const visualizeFailureMessage = (reason: unknown): string => {
  const message = fileDownloadFailureMessage(reason).replace(/^\w*Error:\s*/, '');
  // The main process words a deleted target for the model; say it in the UI language.
  const missing = /^target not found: (.+)$/.exec(message);
  return missing ? t('File not found (it may have been deleted or moved): {{file}}', { file: missing[1] }) : message;
};

/** Download pane `index` to this device (paired remote clients): inline
 *  content and HTML pages as text, everything else as the bytes the pane
 *  loads. */
async function downloadPane(sessionId: string, tabId: string, index: number, pane: VisualizePaneView): Promise<void> {
  const api = window.mixdogDesktop;
  if (pane.inline) {
    await downloadBlob(new Blob([pane.inline.source], { type: 'text/plain' }), visualizeSourceFileName(pane));
    return;
  }
  const source = await api?.visualizePaneSource?.(sessionId, tabId, index);
  if (source?.srcdoc !== undefined) {
    await downloadBlob(
      new Blob([source.srcdoc], { type: 'text/html' }),
      visualizeSourceFileName({ label: pane.label })
    );
    return;
  }
  if (!source?.url) throw new Error(t('Source unavailable'));
  try {
    const blob = await (await fetch(source.url)).blob();
    // An Office document is served as its PDF conversion.
    await downloadBlob(blob, pane.kind === 'document' ? `${pane.label}.pdf` : pane.label);
  } finally {
    URL.revokeObjectURL(source.url);
  }
}

function HistoryList({ items, onPick }: { items: VisualizeHistoryItem[]; onPick(item: VisualizeHistoryItem): void }) {
  return (
    <ul className="visualize-history" aria-label={t('All visuals')}>
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className={`visualize-history-item${item.open ? ' is-open' : ''}`}
            onClick={() => onPick(item)}
          >
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

/** The header's version button and its menu: versions newest first (the
 *  shown one checked), Back to live while a kept version is shown, Compare,
 *  and Restore for a kept version of a file tab. Null until the tab keeps two
 *  versions. A failed restore is reported through `setNotice`. */
export function visualizeVersionActions(
  sessionId: string,
  tab: Tab,
  setNotice: (notice: Notice) => void
): DockAction | null {
  const position = visualizeVersionPosition(tab);
  if (!position) return null;
  const snapshot = tab.version ?? null;
  const show = (version: number | null) => {
    // Comparing stays on: the newest version then sits beside live.
    if (tab.compare) showVisualizeVersion(sessionId, tab.id, version ?? position.newest, true);
    else showVisualizeVersion(sessionId, tab.id, version);
  };
  const restore = () => {
    if (snapshot === null) return;
    const files = [...new Set(tab.panes.filter((pane) => pane.version !== undefined).map((pane) => pane.target))].join(
      ', '
    );
    // Kept page assets that changed since: other pages may share them.
    const assets = tab.restoreAssets ?? [];
    const message = assets.length
      ? t('Restore v{{n}}? This overwrites {{files}} in the project, and also restores {{assets}}.', {
          n: snapshot,
          files,
          assets: assets.join(', '),
        })
      : t('Restore v{{n}}? This overwrites {{files}} in the project.', { n: snapshot, files });
    void confirmAction(message, { confirmLabel: t('Restore'), danger: true }).then((approved) => {
      if (!approved) return;
      return restoreVisualizeVersion(sessionId, tab.id, snapshot, assets).catch((reason: unknown) =>
        setNotice({ error: true, text: visualizeFailureMessage(reason) })
      );
    });
  };
  const list = [...(tab.versions ?? [])].reverse();
  const items: DockAction[] = [];
  if (snapshot !== null) {
    items.push({ id: 'version-live', label: t('Back to current version'), icon: Undo2, onSelect: () => show(null) });
  }
  list.forEach((version, index) => {
    items.push({
      id: `version-${version.n}`,
      label: version.n === position.newest ? t('v{{n}} · current', { n: version.n }) : versionTag(version.n),
      detail: visualizeHistoryTime(version.at),
      checked: version.n === position.shown,
      separatorBefore: index === 0 && snapshot !== null,
      onSelect: () => (version.n === position.newest && !tab.compare ? show(null) : show(version.n)),
    });
  });
  items.push({
    id: 'version-compare',
    label: t('Compare'),
    checked: tab.compare === true,
    checkbox: true,
    separatorBefore: true,
    onSelect: () => toggleVisualizeCompare(sessionId, tab),
  });
  if (snapshot !== null && !tab.panes.some((pane) => pane.inline)) {
    items.push({ id: 'version-restore', label: t('Restore'), onSelect: restore });
  }
  return {
    id: 'versions',
    label: t('Versions'),
    detail: snapshot !== null ? t('Viewing v{{n}} · read-only', { n: snapshot }) : t('Versions'),
    icon: History,
    inline: true,
    attention: snapshot !== null,
    submenu: items,
    onSelect: () => {},
  };
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
  // One toast at a time per panel; a newer outcome replaces the previous one.
  const toast = useRef<string | undefined>(undefined);
  const setNotice = useCallback((notice: Notice | null) => {
    dismissDesktopToast(toast.current);
    if (!notice) {
      toast.current = undefined;
      return;
    }
    toast.current = showDesktopToast(notice.text, notice.error ? 'error' : 'info', { scope: 'visualize' });
  }, []);
  // A file just saved to the project, offered as "Open" in the ⋯ menu.
  const [saved, setSaved] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: session and tab are the reset triggers
  useEffect(() => {
    setNotice(null);
    setSaved(null);
  }, [sessionId, tabId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger
  useEffect(() => setHistoryOpen(false), [sessionId]);

  // With no tab open (the panel opened from the agent chat header), the
  // session's list is the panel's content.
  const listShown = historyOpen || (tab === null && Boolean(state.history?.length));
  const sourceKey = `${sessionId}\0${tabId}`;
  const sourceOn = tab !== null && sourceTabs.has(sourceKey);
  const actions: DockAction[] = [];
  if (state.history) {
    actions.push({
      id: 'history',
      label: t('All visuals'),
      icon: LayoutList,
      checked: listShown,
      checkbox: true,
      onSelect: () => setHistoryOpen(!historyOpen),
    });
  }
  if (tab?.panes.some(visualizePaneHasSource)) {
    actions.push({
      id: 'source',
      label: t('Source'),
      icon: Code,
      checked: sourceOn,
      checkbox: true,
      onSelect: () =>
        setSourceTabs((current) => {
          const next = new Set(current);
          if (!next.delete(sourceKey)) next.add(sourceKey);
          return next;
        }),
    });
  }

  const versions = tab ? visualizeVersionActions(sessionId, tab, setNotice) : null;
  if (versions) actions.push(versions);

  const index = tab ? visualizeExportPane(tab) : 0;
  const pane = tab?.panes[index];
  const run = (task: Promise<unknown>) =>
    task.catch((reason: unknown) => setNotice({ error: true, text: visualizeFailureMessage(reason) }));
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
        setNotice({ error: false, text: t('Saved to {{path}}', { path }) });
        if (format === 'project' && result.openable) setSaved(result.path);
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
      // PNG / PDF: rendered on the host, then this device's own download.
      if (visualizeRemoteExportAvailable()) {
        const exportRemote = (format: 'png' | 'pdf') => {
          setNotice({ error: false, text: t('Exporting…') });
          return run(downloadVisualizeExport(sessionId, tabId, format, index).then(() => setNotice(null)));
        };
        actions.push({
          id: 'export-png',
          label: t('Save as PNG'),
          icon: Download,
          onSelect: () => void exportRemote('png'),
        });
        if (pane.kind === 'html' || pane.kind === 'pdf') {
          actions.push({
            id: 'export-pdf',
            label: t('Save as PDF'),
            icon: Download,
            onSelect: () => void exportRemote('pdf'),
          });
        }
      }
    } else {
      actions.push({ id: 'export-png', label: t('Save as PNG'), icon: Download, onSelect: () => void exportTo('png') });
      if (pane.kind === 'html') {
        actions.push({
          id: 'export-pdf',
          label: t('Save as PDF'),
          icon: Download,
          onSelect: () => void exportTo('pdf'),
        });
      }
    }
    if (pane.inline) {
      actions.push({
        id: 'export-project',
        label: t('Save to project'),
        icon: Save,
        onSelect: () => void exportTo('project'),
      });
    }
  }
  if (tab && saved) {
    const file = saved;
    actions.push({
      id: 'open-saved',
      label: t('Open'),
      detail: file,
      icon: ExternalLink,
      onSelect: () => {
        setSaved(null);
        void run(reopenVisualizeTargets(sessionId, tabId, [file], ''));
      },
    });
  }

  const strips =
    listShown && state.history ? (
      <HistoryList
        items={state.history}
        onPick={(item) => {
          setHistoryOpen(false);
          void run(openVisualizeHistory(sessionId, item.id));
        }}
      />
    ) : null;
  return { actions, strips, sourceOn };
}
