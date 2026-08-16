import type { BrowserWindow } from 'electron';

export async function clickProbeSession(
  window: BrowserWindow,
  id: string,
  waitMs: number,
): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('[data-session-id="${id}"]');
    if (!(row instanceof HTMLElement)) throw new Error('Missing switch probe row: ${id}');
    row.click();
    await new Promise((resolve) => setTimeout(resolve, ${waitMs}));
    return true;
  })()`);
}

export const COLLECT_SWITCH_FRAMES_SCRIPT = `(() => {
  cancelAnimationFrame(window.__switchProbe.raf);
  return window.__switchProbe.frames;
})()`;
