// Window title bar: a clean drag band. The workspace tab strips moved into
// the panes themselves (WorkspaceTabStrip); the bar
// keeps the draggable run, the updater badge, and the Windows caption reserve.
import { ArrowDown, MonitorSmartphone } from 'lucide-react';
import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';

import { version as appVersion } from '../../package.json';
import type { DesktopUpdaterState } from '../shared/contract';
import { remoteWindowInfo } from '../shared/remote-window';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';

import type { ChangelogRelease } from './settings/changelog';
import { takeWhatsNew } from './settings/whats-new';

function readWhatsNewPending(): boolean {
  try {
    return takeWhatsNew(window.localStorage, appVersion);
  } catch {
    return false;
  }
}

interface DesktopTitlebarProps {
  updaterState?: DesktopUpdaterState;
  onOpenUpdate?(): void;
}

export function DesktopTitlebar({ updaterState, onOpenUpdate }: DesktopTitlebarProps) {
  // The - ㅁ x caption band belongs to the ELECTRON shell alone. A browser or
  // web surface serves the SAME bundle through the relay/LAN bridge
  // (remote-shim installs mixdogRemoteServer there), and reserving a caption
  // strip there only steals the title row of a window that has no caption.
  const electronShell = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);
  const windowsCaptionControls = electronShell && /Windows/i.test(navigator.userAgent);
  const remoteHost = remoteWindowInfo();
  // The updater stays window-global; layout controls belong to their panes.
  const updateVisible =
    Boolean(onOpenUpdate) && (updaterState?.status === 'ready' || updaterState?.status === 'installing');
  const updateInstalling = updaterState?.status === 'installing';
  // The first launch after an update announces that version's notes once.
  const [whatsNew] = useState(readWhatsNewPending);
  const [notice, setNotice] = useState<{
    Dialog: ComponentType<{ release: ChangelogRelease; onClose(): void; onViewAll(): void }>;
    release: ChangelogRelease;
  } | null>(null);
  const [ChangelogDialog, setChangelogDialog] = useState<ComponentType<{ onClose(): void }> | null>(null);
  const closeChangelog = () => setChangelogDialog(null);
  const closeNotice = useCallback(() => setNotice(null), []);
  const openChangelog = () => {
    setNotice(null);
    void import('./settings/changelog-dialog')
      .then(async (module) => {
        await module.prepareChangelog();
        setChangelogDialog(() => module.default);
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    if (!whatsNew) return;
    let cancelled = false;
    void import('./settings/whats-new-dialog')
      .then(async (module) => {
        const release = await module.prepareWhatsNew();
        if (release && !cancelled) setNotice({ Dialog: module.default, release });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [whatsNew]);
  useEffect(() => {
    if (!ChangelogDialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChangelogDialog(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ChangelogDialog]);
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the top-level header is the window's banner landmark, which takes a name.
    <header className="topbar" aria-label={t('Window bar')}>
      {/* No brand mark: the bare band reads lighter (user: 로고 뺄까 뭔가
          로고 있으니까 답답하네). */}
      <div className="titlebar-spacer" aria-hidden="true" />
      {/* "Connect to another PC": this whole window drives another computer, so
          the chrome says which one (the window title says it too). */}
      {remoteHost && (
        <div className="titlebar-remote-host" role="status" title={remoteHost.hostName}>
          <MonitorSmartphone size={14} aria-hidden="true" />
          <span>{t('Connected to {{host}}', { host: remoteHost.hostName })}</span>
        </div>
      )}
      {/* RIGHT cluster: updater badge ahead of the native caption reserve.
          Layout surfaces use contextual pane entry points. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own border, padding and min-width into the titlebar. */}
      <div className="titlebar-leading titlebar-controls" role="group" aria-label={t('Layout controls')}>
        {updateVisible && (
          <button
            type="button"
            className="icon-button titlebar-update"
            onClick={onOpenUpdate}
            disabled={updateInstalling}
            aria-busy={updateInstalling}
            aria-label={
              updateInstalling
                ? t('Installing update')
                : t('Install Mixdog {{version}}', { version: updaterState?.version })
            }
            data-tooltip={updateInstalling ? t('Installing update') : t('Update')}
          >
            {updateInstalling ? (
              <ProgressSpinner size={12} className="sidebar-update-loader" aria-hidden="true" />
            ) : (
              <ArrowDown size={16} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      {windowsCaptionControls && <div className="titlebar-caption-space" aria-hidden="true" />}
      {notice &&
        createPortal(
          <notice.Dialog release={notice.release} onClose={closeNotice} onViewAll={openChangelog} />,
          document.body
        )}
      {ChangelogDialog && createPortal(<ChangelogDialog onClose={closeChangelog} />, document.body)}
    </header>
  );
}
