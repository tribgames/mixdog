/**
 * The banner and controls the user sees while an agent drives the desktop,
 * on every display at once. It is the user's only signal that their computer
 * is being used, so a render that dies never vanishes without a trace, and
 * the Stop shortcut works whenever the banner is up or the user holds control.
 */
import { globalShortcut, screen } from 'electron';

import { computerUseCoordinator, type ComputerUseSnapshot } from '../session/coordinator';
import { createComputerOverlayController, type ComputerUseOverlayControls } from './controls';
import { createComputerUseCursorOverlay } from './cursor-overlay';
import { computerUseOverlayPresentation } from './model';
import { createOverlayFade } from './overlay-fade';
import { createOverlayWindows } from './overlay-windows';
import { renderComputerOverlayWindows } from './render-windows';

export type { ComputerUseOverlayControls } from './controls';

const STOP_SHORTCUT = 'CommandOrControl+Alt+Escape';

export interface ComputerUseOverlay {
  dispose(): void;
}

export function createComputerUseOverlay(controls: ComputerUseOverlayControls, locale = 'en'): ComputerUseOverlay {
  const cursorOverlay = createComputerUseCursorOverlay();
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
  });
  const fade = createOverlayFade({ liveEntries: windows.liveEntries, visible: () => latestPresentation.visible });

  const stop = (): void => {
    void controller.invoke('stop', latestPresentation.generation, latestPresentation.sessionIds);
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

  const render = async (): Promise<void> => {
    const currentRender = ++renderRevision;
    const revision = latestSnapshot.revision;
    const presentation = computerUseOverlayPresentation(
      latestSnapshot,
      locale,
      controller.state(latestSnapshot.takeoverGeneration ?? 0)
    );
    latestPresentation = presentation;
    if (!presentation.visible) {
      windows.forgetRendered();
      fade.hideAll();
      return;
    }
    fade.keepShown();
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

  const unsubscribe = computerUseCoordinator.subscribe((snapshot) => {
    if (latestSnapshot.userControlActive && !snapshot.userControlActive) windows.resetRendererFailures();
    latestSnapshot = snapshot;
    scheduleRender();
  });
  const shortcutRegistered = globalShortcut.register(STOP_SHORTCUT, () => {
    if (latestPresentation.visible || latestSnapshot.userControlActive) stop();
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
      windows.destroyAll();
      cursorOverlay.dispose();
    },
  };
}
