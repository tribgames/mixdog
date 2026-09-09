import type { WebContents } from 'electron';
import type { DesktopRemoteBrowserControl } from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import type { BrowserGuestStateStore } from './guest-state';
import { createBrowserInputDriver } from './input';

export function remoteBrowserDocumentId(state: BrowserGuestStateStore, guest: WebContents): string {
  const record = state.for(guest);
  return `${record.pageId}:${record.documentGeneration}`;
}

/** Human typing follows the displayed document, not its blinking caret or
 * changing pixels. Keep the document check at dispatch, including after CDP
 * attachment, so queued text can never move to a replacement page. */
export async function sendRemoteBrowserKeyboard(
  host: {
    state: BrowserGuestStateStore;
    cdp: Pick<BrowserGuestCdp, 'guestDebugger' | 'sendCdpInput'>;
  },
  guest: WebContents,
  control: Extract<DesktopRemoteBrowserControl, { type: 'text' | 'key' }>,
): Promise<void> {
  const assertCurrent = () => {
    if (guest.isDestroyed() || host.state.for(guest).crashed
      || control.documentId !== remoteBrowserDocumentId(host.state, guest)) {
      throw new Error('Remote Browser Use page changed; input was not sent.');
    }
    if (host.state.for(guest).pendingDialog) {
      throw new Error('Remote Browser Use dialog is blocking input.');
    }
  };
  const send = async (_guest: WebContents, method: string, params: Record<string, unknown>) => {
    assertCurrent();
    const debuggerInstance = await host.cdp.guestDebugger(guest);
    assertCurrent();
    host.state.invalidateInteraction(guest);
    return await host.cdp.sendCdpInput(guest, debuggerInstance, method, params);
  };
  assertCurrent();
  if (control.type === 'text') {
    await send(guest, 'Input.insertText', { text: control.text });
  } else {
    await createBrowserInputDriver(send).pressKey(guest, control.key);
  }
}
