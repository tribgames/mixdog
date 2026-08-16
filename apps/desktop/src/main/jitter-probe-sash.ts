import type { BrowserWindow } from 'electron';

export type SashGeometry = {
  x: number;
  y: number;
  minX: number;
  maxX: number;
};

export async function readProbeSash(window: BrowserWindow): Promise<SashGeometry | null> {
  return window.webContents.executeJavaScript(`(() => {
    const transcript = [...document.querySelectorAll('.transcript')]
      .find((candidate) => candidate.getBoundingClientRect().height > 0
        && candidate.querySelectorAll('.transcript-virtual-row').length > 3);
    const handle = document.querySelector('.pane-split-row > .pane-resize-handle');
    const split = handle?.parentElement;
    if (!transcript || !handle || !split) return null;
    const handleBox = handle.getBoundingClientRect();
    const splitBox = split.getBoundingClientRect();
    return {
      x: handleBox.left + handleBox.width / 2,
      y: handleBox.top + handleBox.height / 2,
      minX: Math.round(splitBox.left + 324),
      maxX: Math.round(splitBox.right - 324),
    };
  })()`) as Promise<SashGeometry | null>;
}

export async function dragProbeSash(
  window: BrowserWindow,
  initialSash: SashGeometry,
  sleep: (ms: number) => Promise<unknown>,
): Promise<void> {
  const debug = window.webContents.debugger;
  const wasAttached = debug.isAttached();
  if (!wasAttached) debug.attach('1.3');
  try {
    const start = (await readProbeSash(window))?.x;
    if (start === undefined) {
      throw new Error('width probe: pane sash disappeared before drag');
    }
    const moveTo = async (targetX: number) => {
      let geometry = await readProbeSash(window);
      while (geometry && Math.abs(targetX - geometry.x) > 1) {
        const direction = Math.sign(targetX - geometry.x);
        let next: SashGeometry | null = null;
        let requested = geometry.x;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await readProbeSash(window);
          if (!current) break;
          geometry = current;
          const step = Math.max(4, 12 - attempt * 4);
          requested = direction > 0
            ? Math.min(targetX, geometry.x + step)
            : Math.max(targetX, geometry.x - step);
          await debug.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: geometry.x,
            y: geometry.y,
            button: 'none',
            buttons: 0,
            pointerType: 'mouse',
          });
          await sleep(8);
          await debug.sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: geometry.x,
            y: geometry.y,
            button: 'left',
            buttons: 1,
            clickCount: 1,
            pointerType: 'mouse',
          });
          await sleep(8);
          await debug.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: requested,
            y: geometry.y,
            button: 'left',
            buttons: 1,
            pointerType: 'mouse',
          });
          await debug.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: requested,
            y: geometry.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
            pointerType: 'mouse',
          });
          await sleep(30);
          next = await readProbeSash(window);
          if (next && Math.abs(next.x - geometry.x) >= 1) break;
        }
        if (!next || Math.abs(next.x - geometry.x) < 1) {
          if (Math.abs(targetX - geometry.x) <= 4.5) break;
          throw new Error(`width probe: pane sash stalled ${JSON.stringify({
            from: geometry.x,
            requested,
            actual: next?.x,
          })}`);
        }
        geometry = next;
      }
      if (!geometry) {
        throw new Error('width probe: pane sash disappeared during drag');
      }
    };
    await moveTo(initialSash.minX);
    await moveTo(initialSash.maxX);
    await moveTo(start);
    const restored = await readProbeSash(window);
    if (!restored || Math.abs(restored.x - start) > 2) {
      throw new Error(`width probe: pane sash did not restore ${JSON.stringify({
        start,
        restored,
      })}`);
    }
    await debug.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: restored.x,
      y: restored.y,
      button: 'none',
      buttons: 0,
      pointerType: 'mouse',
    });
  } finally {
    if (!wasAttached) {
      try {
        debug.detach();
      } catch {
        // The target closed with the probe.
      }
    }
  }
  await sleep(400);
}
