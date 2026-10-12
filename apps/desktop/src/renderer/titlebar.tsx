// Window title bar: a clean drag band. The workspace tab strips moved into
// the panes themselves (WorkspaceTabStrip); the bar
// keeps the draggable run, the updater badge, and the Windows caption reserve.
import { ArrowDown } from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';

import { version as appVersion } from '../../package.json';
import type { DesktopUpdaterState } from '../shared/contract';
import { t } from './i18n';
import { useMobileRemoteSurface } from './mobile-surface';
import { RemotePcSwitcher } from './RemotePcSwitcher';
import { ProgressSpinner } from './ProgressSpinner';
import { useWhatsNewNotice } from './settings/use-whats-new-notice';

interface DesktopTitlebarProps {
  updaterState?: DesktopUpdaterState;
  onOpenUpdate?(): void;
}

export function DesktopTitlebar({ updaterState, onOpenUpdate }: DesktopTitlebarProps) {
  // The - ㅁ x caption band belongs to the ELECTRON shell alone. A browser or
  // web surface serves the SAME bundle through the relay/LAN bridge
  // (remote-shim installs mixdogRemoteServer there), and reserving a caption
  // strip there only steals the title row of a window that has no caption.
  const phoneLayout = useMobileRemoteSurface();
  const electronShell = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);
  // Windows and Linux both draw native caption controls via the overlay.
  const windowsCaptionControls = electronShell && /Windows|Linux/i.test(navigator.userAgent);
  // The updater stays window-global; layout controls belong to their panes.
  const updateVisible =
    Boolean(onOpenUpdate) && (updaterState?.status === 'ready' || updaterState?.status === 'installing');
  const updateInstalling = updaterState?.status === 'installing';
  const { notice, closeNotice } = useWhatsNewNotice(appVersion);
  const [ChangelogDialog, setChangelogDialog] = useState<ComponentType<{ onClose(): void }> | null>(null);
  const closeChangelog = () => setChangelogDialog(null);
  const openChangelog = () => {
    closeNotice();
    void import('./settings/changelog-dialog')
      .then(async (module) => {
        await module.prepareChangelog();
        setChangelogDialog(() => module.default);
      })
      .catch(() => undefined);
  };
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
      {/* No brand mark: the bare band reads lighter. */}
      {/* The leading edge holds the PC menu: a remote surface names the PC it
          drives ("● PC ▾"); the main window shows nothing until
          PCs are saved, then "● this PC ▾". The phone has no title row; its
          brand button and drawer carry the same information. */}
      {!phoneLayout && <RemotePcSwitcher />}
      <div className="titlebar-spacer" aria-hidden="true" />
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
