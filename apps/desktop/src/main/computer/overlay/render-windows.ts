import type { BrowserWindow } from 'electron';
import type { ComputerUseOverlayPresentation } from './model';

/** A renderer reply can arrive after execution ends, disposal, or a newer render.
 * Revalidate after every await before committing presentation state or showing UI. */
export async function renderComputerOverlayWindows(
  entries: Array<{ window: BrowserWindow; lastRenderedPresentation: string }>,
  presentation: ComputerUseOverlayPresentation,
  renderRevision: number,
  isCurrent: () => boolean,
): Promise<void> {
  if (!presentation.visible) return;
  const serialized = JSON.stringify(presentation).replaceAll('<', '\\u003c');
  const script = `window.mixdogComputerOverlay?.(${JSON.stringify({
    ...presentation, renderRevision,
  }).replaceAll('<', '\\u003c')})`;
  await Promise.all(entries.map(async (entry) => {
    const canRender = () => isCurrent() && !entry.window.isDestroyed();
    if (!canRender()) return;
    if (serialized !== entry.lastRenderedPresentation) {
      await entry.window.webContents.executeJavaScript(script);
      if (!canRender()) return;
      entry.lastRenderedPresentation = serialized;
    }
    if (!entry.window.isVisible()) entry.window.showInactive();
  }));
}
