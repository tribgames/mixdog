/**
 * The banner and controls the user sees while an agent drives the desktop,
 * on every display at once. It is the user's only signal that their computer
 * is being used, so a render that dies never vanishes without a trace, and
 * the Stop shortcut works whenever the banner is up or the user holds control.
 */
import { globalShortcut, screen } from 'electron';

import { getLinuxComputerReadiness } from '../../../../../../src/runtime/computer-bridge/linux-readiness.mjs';
import { usesGnomeHelper, watchGnomeStopSignal } from '../host/gnome-helper';
import { computerUseCoordinator, type ComputerUseSnapshot } from '../session/coordinator';
import { createComputerOverlayController, type ComputerUseOverlayControls } from './controls';
import { createComputerUseCursorOverlay } from './cursor-overlay';
import { createGnomeIndicator } from './gnome-indicator';
import { computerUseOverlayPresentation } from './model';
import { createOverlayFade } from './overlay-fade';
import { setComputerUsePillShown } from './overlay-presence';
import { createOverlayWindows } from './overlay-windows';
import { renderComputerOverlayWindows } from './render-windows';

export type { ComputerUseOverlayControls } from './controls';

const STOP_SHORTCUT = 'CommandOrControl+Alt+Escape';

export interface ComputerUseOverlay {
  dispose(): void;
}

/** Test seams for the GNOME shell path; production passes none. */
export interface ComputerUseOverlaySeams {
  indicator?: Pick<ReturnType<typeof createGnomeIndicator>, 'show' | 'dispose'>;
  helperReady?: () => Promise<boolean>;
}

export function createComputerUseOverlay(
  controls: ComputerUseOverlayControls,
  locale = 'en',
  seams: ComputerUseOverlaySeams = {}
): ComputerUseOverlay {
  // On GNOME Wayland no Electron window may exist while an agent drives: a
  // client window cannot refuse focus there and would take it from the target.
  // The shell extension draws the pill instead, and the virtual cursor surface
  // is skipped (the real pointer is moved, and is visible).
  const gnome = Boolean(seams.indicator) || usesGnomeHelper();
  const indicator = seams.indicator ?? (gnome ? createGnomeIndicator(locale) : null);
  const cursorOverlay = gnome ? { dispose(): void {} } : createComputerUseCursorOverlay();
  let disposed = false;
  let latestSnapshot: ComputerUseSnapshot = computerUseCoordinator.snapshot();
  let latestPresentation = computerUseOverlayPresentation(latestSnapshot, locale);
  /** Pending re-assert of the bounds that a first show may have shifted. */
  let settleTimer: NodeJS.Timeout | null = null;
  let renderRevision = 0;
  const controller = createComputerOverlayController(controls, () => {
    if (!disposed) scheduleRender();
  });
  const windows = createOverlayWindows({
    locale,
    controls,
    controller,
    presentation: () => latestPresentation,
    isDisposed: () => disposed,
    requestRender: () => scheduleRender(),
  });
  const fade = createOverlayFade({
    liveEntries: windows.liveEntries,
    visible: () => latestPresentation.visible,
    onHidden: () => setComputerUsePillShown(false),
  });

  const stop = (): void => {
    void controller.invoke('stop', latestPresentation.sessionIds);
  };

  /** Windows lays out a transparent always-on-top window only once it actually
   * appears, so the DPI and frame correction arrives after the first show and
   * leaves the pill a few pixels off the bounds it was created with, which reads
   * as the overlay jumping into place. Re-assert the position once that show has
   * gone through the message loop. */
  const settleShownBounds = (): void => {
    if (settleTimer) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (disposed) return;
      windows.repositionAll(true);
    }, 0);
    settleTimer.unref?.();
  };

  const helperReady =
    seams.helperReady ??
    (async (): Promise<boolean> => (await getLinuxComputerReadiness()).capabilities.windows.state === 'ready');

  const render = async (): Promise<void> => {
    ensureShortcut();
    const currentRender = ++renderRevision;
    const revision = latestSnapshot.revision;
    const presentation = computerUseOverlayPresentation(latestSnapshot, locale, controller.state());
    latestPresentation = presentation;
    const shellDraws = indicator ? await helperReady() : false;
    // Disposal may have happened while readiness was pending: nothing below
    // may run, or it would set presence that no subscription is left to clear.
    if (disposed) return;
    if (indicator && shellDraws) {
      if (currentRender !== renderRevision) return;
      windows.forgetRendered();
      fade.hideAll();
      // The shell draws this pill; claim its slot for the remote pill too.
      if (presentation.visible) setComputerUsePillShown(true, 'shell');
      await indicator.show(presentation);
      if (currentRender === renderRevision && !presentation.visible) setComputerUsePillShown(false, 'shell');
      return;
    }
    if (!presentation.visible) {
      windows.forgetRendered();
      fade.hideAll();
      return;
    }
    fade.keepShown();
    // Claim the top slot before the pill appears, so a remote pill already
    // there steps below rather than being drawn over.
    setComputerUsePillShown(true);
    await windows.syncToDisplays();
    if (disposed) return;
    if (currentRender !== renderRevision) return;
    if (latestSnapshot.revision !== revision) {
      scheduleRender();
      return;
    }
    windows.repositionAll();
    const entries = windows.liveEntries();
    const appearing = entries.filter((entry) => !entry.window.isVisible());
    await renderComputerOverlayWindows(
      entries,
      presentation,
      currentRender,
      () =>
        !disposed &&
        currentRender === renderRevision &&
        latestSnapshot.revision === revision &&
        latestPresentation.visible
    );
    if (appearing.some((entry) => !entry.window.isDestroyed() && entry.window.isVisible())) settleShownBounds();
  };

  /** This overlay is the user's only signal that an agent is driving their
   * desktop, so a render that dies must not vanish without a trace. */
  const scheduleRender = (): void => {
    void render().catch((error) => {
      console.warn('[computer-overlay] render_failed', String((error as Error)?.message || error));
    });
  };

  let shortcutRegistered = false;
  let shortcutWarned = false;
  let stopWatcher: (() => void) | null = null;
  const onStopShortcut = (): void => {
    // The pill leaves between commands, but a turn that used the computer can
    // still use it again: the emergency Stop reaches every such session.
    const active =
      latestPresentation.visible ||
      latestPresentation.sessionIds.length > 0 ||
      latestSnapshot.userControlActive ||
      latestSnapshot.cleanupState !== 'ready';
    console.log('[computer-overlay] stop_shortcut', active ? 'stopping' : 'idle');
    if (active) stop();
  };
  /** Another process may own the chord; retry on every render until it is ours. */
  const ensureShortcut = (): void => {
    if (shortcutRegistered || disposed) return;
    // Electron cannot register global shortcuts on Wayland; on GNOME the shell
    // extension owns the chord and reports it over D-Bus.
    if (usesGnomeHelper()) {
      stopWatcher ??= watchGnomeStopSignal(onStopShortcut);
      return;
    }
    shortcutRegistered = globalShortcut.register(STOP_SHORTCUT, onStopShortcut);
    if (shortcutRegistered) shortcutWarned = false;
    else if (!shortcutWarned) {
      // The pill's Stop control still works, but the documented emergency exit
      // does not, so the failure stays visible (once per state change).
      shortcutWarned = true;
      console.warn('[computer-overlay] stop_shortcut_unavailable', STOP_SHORTCUT);
    }
  };
  ensureShortcut();
  const unsubscribe = computerUseCoordinator.subscribe((snapshot) => {
    if (latestSnapshot.userControlActive && !snapshot.userControlActive) windows.resetRendererFailures();
    latestSnapshot = snapshot;
    if (!snapshot.userControlActive && snapshot.cleanupState === 'ready') controller.clearResolvedError();
    scheduleRender();
  });
  const onDisplaysChanged = (): void => {
    if (disposed) return;
    if (latestPresentation.visible) {
      // Visible: create windows for new displays and reposition existing ones.
      scheduleRender();
      return;
    }
    // Hidden: windows for new displays are created lazily on the next visible render.
    windows.dropWindowsForMissingDisplays(screen.getAllDisplays());
    windows.repositionAll();
  };
  screen.on('display-metrics-changed', onDisplaysChanged);
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      fade.dispose();
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      screen.removeListener('display-metrics-changed', onDisplaysChanged);
      screen.removeListener('display-added', onDisplaysChanged);
      screen.removeListener('display-removed', onDisplaysChanged);
      if (shortcutRegistered) globalShortcut.unregister(STOP_SHORTCUT);
      stopWatcher?.();
      stopWatcher = null;
      indicator?.dispose();
      windows.destroyAll();
      setComputerUsePillShown(false);
      setComputerUsePillShown(false, 'shell');
      cursorOverlay.dispose();
    },
  };
}
