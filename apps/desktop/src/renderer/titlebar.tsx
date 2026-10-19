// Window title bar: a clean drag band. The workspace tab strips moved into
// the panes themselves (WorkspaceTabStrip); the bar keeps the draggable run
// and the Windows caption reserve. The updater lives in the activity rail.
import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ComponentType } from 'react';
import { createPortal } from 'react-dom';

import { version as appVersion } from '../../package.json';
import { t } from './i18n';
import { useMobileRemoteSurface } from './mobile-surface';
import { RemotePcSwitcher } from './RemotePcSwitcher';
import { isElectronRenderer } from './remote-ui-projection';
import { useWhatsNewNotice } from './settings/use-whats-new-notice';

type WindowControlsOverlay = EventTarget & { readonly visible: boolean };

function windowControlsOverlay(): WindowControlsOverlay | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;
}

function subscribeWindowControlsOverlay(listener: () => void): () => void {
  const overlay = windowControlsOverlay();
  overlay?.addEventListener('geometrychange', listener);
  return () => overlay?.removeEventListener('geometrychange', listener);
}

const windowControlsOverlayVisible = (): boolean => windowControlsOverlay()?.visible === true;

function useWindowControlsOverlayVisible(): boolean {
  return useSyncExternalStore(subscribeWindowControlsOverlay, windowControlsOverlayVisible, () => false);
}

/** A plain browser tab (not Electron, not the phone layout, no native caption
 *  overlay) has nothing to drag and no caption to clear: it drops the title
 *  band and the activity rail carries the PC switcher at its top instead. */
export function usePlainBrowserChrome(): boolean {
  const phoneLayout = useMobileRemoteSurface();
  const captionOverlay = useWindowControlsOverlayVisible();
  return !isElectronRenderer() && !phoneLayout && !captionOverlay;
}

export function DesktopTitlebar() {
  // The - ㅁ x caption reserve exists only where the window really draws
  // native caption controls over the page (Window Controls Overlay: the
  // Windows/Linux main window and other-PC windows). A browser tab, a phone or
  // macOS has none, and a reserve there only steals the title row.
  const phoneLayout = useMobileRemoteSurface();
  const windowsCaptionControls = useWindowControlsOverlayVisible();
  const bandless = usePlainBrowserChrome();
  // Band-height consumers (floating side sheet, backdrop, dialogs) read
  // --titlebar-height; the root marker zeroes it while no band renders.
  useLayoutEffect(() => {
    if (!bandless) return undefined;
    const root = document.documentElement;
    root.setAttribute('data-mixdog-titlebar', 'hidden');
    return () => root.removeAttribute('data-mixdog-titlebar');
  }, [bandless]);
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
  const dialogs = (
    <>
      {notice &&
        createPortal(
          <notice.Dialog release={notice.release} onClose={closeNotice} onViewAll={openChangelog} />,
          document.body
        )}
      {ChangelogDialog && createPortal(<ChangelogDialog onClose={closeChangelog} />, document.body)}
    </>
  );
  if (bandless) return dialogs;
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
      {windowsCaptionControls && <div className="titlebar-caption-space" aria-hidden="true" />}
      {dialogs}
    </header>
  );
}
