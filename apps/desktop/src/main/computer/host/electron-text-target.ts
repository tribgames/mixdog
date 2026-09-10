import { screen, type BrowserWindow } from 'electron';

/** Return only readiness, never field contents or application text. */
export function typingTargetProbe(point?: { x: number; y: number }): string {
  return `(() => {
    const point = ${JSON.stringify(point ?? null)};
    let root = document;
    let active = root.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (!active || active.disabled || active.readOnly) return false;
    const editable = active.isContentEditable || active.tagName === 'TEXTAREA'
      || (active.tagName === 'INPUT' && ['text','search','url','tel','email','password','number'].includes(active.type));
    if (!editable) return false;
    if (!point) return true;
    let hit = root.elementFromPoint(point.x, point.y);
    while (hit?.shadowRoot) {
      const next = hit.shadowRoot.elementFromPoint(point.x, point.y);
      if (!next || next === hit) break;
      hit = next;
    }
    return !!hit && (hit === active || active.contains(hit));
  })()`;
}

export async function waitForElectronTypingTarget(
  window: BrowserWindow, point: { x: number; y: number } | undefined,
  assertAllowed: () => Promise<unknown>,
): Promise<boolean> {
  const deadline = performance.now() + 500;
  do {
    await assertAllowed();
    if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
    const bounds = window.getContentBounds();
    const dip = point ? screen.screenToDipPoint(point) : undefined;
    const zoom = window.webContents.getZoomFactor();
    if (!Number.isFinite(zoom) || zoom <= 0) return false;
    const relative = dip ? { x: (dip.x - bounds.x) / zoom, y: (dip.y - bounds.y) / zoom } : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        window.webContents.executeJavaScript(typingTargetProbe(relative)).then((value) => value === true, () => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
        }),
      ]);
      if (ready) return true;
    } finally { if (timer) clearTimeout(timer); }
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - performance.now())));
  } while (performance.now() < deadline);
  return false;
}
