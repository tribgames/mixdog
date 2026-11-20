import type { WebContents } from 'electron';

/** A left click of the harness shell at (x, y), sent as native input through its debugger. */
export async function clickShellAt(shell: WebContents, { x, y }: { x: number; y: number }): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await shell.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}
