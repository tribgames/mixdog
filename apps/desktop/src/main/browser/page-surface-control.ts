/** Local, user-initiated page controls: tab chrome, prompt answers, resize,
 *  native recovery, navigation, and input dispatched through CDP under the
 *  document guard that ties every event to the page the user still sees. */
import type { WebContents } from 'electron';
import type { DesktopBrowserPageControl } from '../../shared/contract';
import { createBrowserInputDriver } from './input';
import { normalizePageUrl } from './url-policy';
import { browserInputRecovery } from '../../shared/browser-input-policy';
import type { BrowserPageSurfaceHost } from './page-surface';
import type { PageSurfaceState } from './page-surface-state';

export function createPageSurfaceControl(host: BrowserPageSurfaceHost, state: PageSurfaceState) {
  const { paneSizes, invalidateGeometry, presenting } = state;

  function controlTabs(sessionId: string, input: DesktopBrowserPageControl): boolean {
    if (input.type !== 'new-tab' && input.type !== 'select-tab' && input.type !== 'close-tab') return false;
    if (!host.tabs) throw new Error('Browser tabs are unavailable.');
    if (input.type === 'new-tab') host.tabs.create(sessionId);
    else if (input.type === 'select-tab') host.tabs.select(sessionId, input.tabId);
    else host.tabs.close(sessionId, input.tabId);
    return true;
  }

  async function dispatchPageInput(
    guest: WebContents,
    input: DesktopBrowserPageControl,
    assertCurrent: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    await host.cdp.waitForIdle(guest, signal);
    assertCurrent();
    if (host.state.for(guest).pendingDialog) throw new Error('Browser dialog is blocking input.');
    host.state.invalidateInteraction(guest);
    const assertDispatch = () => {
      assertCurrent();
      if (host.state.for(guest).pendingDialog) throw new Error('Browser dialog is blocking input.');
    };
    const send = async (
      target: WebContents,
      method: string,
      params: Record<string, unknown>,
      inputSignal?: AbortSignal
    ) => {
      if (host.dispatchInput) return host.dispatchInput(target, method, params, inputSignal, assertDispatch);
      const debuggerInstance = await host.cdp.guestDebugger(target);
      assertDispatch();
      // The CDP transport may itself wait for cleanup after initialization.
      // Revalidate in that transport, with no await before the actual send.
      return host.cdp.sendCdpInput(target, debuggerInstance, method, params, inputSignal, undefined, assertDispatch);
    };
    // Each key sequence retains its own document guard across every dispatch.
    const keyboard = createBrowserInputDriver(send, { allowClipboard: true });
    switch (input.type) {
      case 'navigate': {
        const url = normalizePageUrl(input.url, host.urlPolicy);
        await host.assertUrl(url, true);
        assertCurrent();
        void guest.loadURL(url).catch(() => {});
        break;
      }
      case 'back':
        if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack();
        break;
      case 'forward':
        if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward();
        break;
      case 'zoom':
        invalidateGeometry(guest);
        guest.setZoomFactor(input.factor);
        break;
      case 'text':
        await send(guest, 'Input.insertText', { text: input.text }, signal);
        break;
      case 'composition':
        await send(
          guest,
          'Input.imeSetComposition',
          {
            text: input.text,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
          },
          signal
        );
        break;
      case 'composition-end':
        await send(
          guest,
          input.text ? 'Input.insertText' : 'Input.imeSetComposition',
          input.text ? { text: input.text } : { text: '', selectionStart: 0, selectionEnd: 0 },
          signal
        );
        break;
      case 'key':
        await keyboard.pressKey(guest, input.key, signal);
        break;
      case 'pointer':
        await send(
          guest,
          'Input.dispatchMouseEvent',
          {
            type: input.phase,
            x: input.x,
            y: input.y,
            button: input.button,
            buttons: input.buttons,
            modifiers: input.modifiers,
            clickCount: input.clickCount,
          },
          signal
        );
        break;
      case 'wheel':
        await send(
          guest,
          'Input.dispatchMouseEvent',
          {
            type: 'mouseWheel',
            x: input.x,
            y: input.y,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
          },
          signal
        );
        break;
    }
  }

  return async function control(
    sessionId: string,
    input: DesktopBrowserPageControl,
    signal?: AbortSignal
  ): Promise<void> {
    // Tab chrome targets a session-owned page, not the document inside it.
    // Navigation and a blocked page dialog must not trap the user on that tab.
    signal?.throwIfAborted();
    if (controlTabs(sessionId, input)) return;
    const guest = await host.ensureGuest(sessionId, { reveal: false });
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (!presenting(sessionId, guest, input.documentId)) {
        throw new Error('Browser page changed; input was not sent.');
      }
    };
    assertCurrent();
    if (input.type === 'answer-dialog' || input.type === 'choose-files') {
      if (!host.prompts) throw new Error('Browser prompt controls are unavailable.');
      await host.prompts.answer(guest, input, assertCurrent, signal);
      host.state.invalidateInteraction(guest);
      return;
    }
    if (input.type === 'resize') {
      const size = { width: Math.round(input.width), height: Math.round(input.height) };
      paneSizes.set(sessionId, size);
      invalidateGeometry(guest);
      host.resize(guest, size.width, size.height);
      return;
    }
    // Native recovery releases a blocked execution; it must not wait for that
    // execution or be rejected by the dialog it is intended to escape.
    if (browserInputRecovery(input)) {
      host.state.invalidateInteraction(guest);
      if (input.type === 'reload') guest.reload();
      else guest.stop();
      return;
    }
    await dispatchPageInput(guest, input, assertCurrent, signal);
  };
}
