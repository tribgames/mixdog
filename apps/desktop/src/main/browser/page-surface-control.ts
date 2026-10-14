/** Local, user-initiated page controls: tab chrome, prompt answers, resize,
 *  native recovery, navigation, and input dispatched through CDP under the
 *  document guard that ties every event to the page the user still sees. */
import type { WebContents } from 'electron';
import type { DesktopBrowserPageControl, DesktopBrowserTabControlResult } from '../../shared/contract';
import { createBrowserInputDriver } from './input';
import { controlSessionTab, isSessionTabControl } from './tabs-close-result';
import { normalizePageUrl } from './url-policy';
import { BROWSER_DIALOG_BLOCKING, browserInputRecovery } from '../../shared/browser-input-policy';
import type { BrowserPageSurfaceHost } from './page-surface';
import type { PageSurfaceState } from './page-surface-state';

/** Float noise from Chromium's zoom-level round trip, not a new zoom. */
const ZOOM_EPSILON = 0.001;

/** Human page input through CDP under the caller's document guard. Shared by
 *  the local pane and paired remote clients so both behave identically. */
export function createPageInputDispatcher(
  host: Pick<BrowserPageSurfaceHost, 'state' | 'cdp' | 'dispatchInput' | 'urlPolicy' | 'assertUrl'>
) {
  return async function dispatchPageInput(
    guest: WebContents,
    input: DesktopBrowserPageControl,
    assertCurrent: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    const assertDispatch = () => {
      assertCurrent();
      if (host.state.for(guest).pendingDialog) throw new Error(BROWSER_DIALOG_BLOCKING);
    };
    await host.cdp.waitForIdle(guest, signal);
    assertDispatch();
    host.state.invalidateInteraction(guest);
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
        if (['Control+c', 'Control+C', 'Meta+c', 'Meta+C'].includes(input.key)) {
          // A human copy gesture uses Chromium's native edit command, not a
          // synthetic key event in the shell's hidden input field.
          assertDispatch();
          guest.copy();
        } else {
          await keyboard.pressKey(guest, input.key, signal);
        }
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
  };
}

/** Set a page's zoom factor; the factor it already has changes nothing. */
export function zoomGuest(
  host: Pick<BrowserPageSurfaceHost, 'state'>,
  state: Pick<PageSurfaceState, 'invalidateGeometry'>,
  guest: WebContents,
  factor: number
): void {
  if (Math.abs(guest.getZoomFactor() - factor) < ZOOM_EPSILON) return;
  state.invalidateGeometry(guest);
  host.state.invalidateInteraction(guest);
  guest.setZoomFactor(factor);
}

export function createPageSurfaceControl(host: BrowserPageSurfaceHost, state: PageSurfaceState) {
  const { paneSizes, paneZooms, invalidateGeometry, resizeGuest, presenting } = state;
  const dispatchPageInput = createPageInputDispatcher(host);

  return async function control(
    sessionId: string,
    input: DesktopBrowserPageControl,
    signal?: AbortSignal
  ): Promise<DesktopBrowserTabControlResult | void> {
    // Tab chrome targets a session-owned page, not the document inside it.
    // Navigation and a blocked page dialog must not trap the user on that tab.
    signal?.throwIfAborted();
    if (isSessionTabControl(input)) return controlSessionTab(host.tabs, sessionId, input);
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
      resizeGuest(guest, size);
      return;
    }
    // The pane re-applies its zoom on every attach, navigation and resize.
    // Re-applying the factor the guest already has changes nothing: it must
    // not discard the agent's refs, and it never waits for page execution.
    if (input.type === 'zoom') {
      paneZooms.set(sessionId, input.factor);
      // A driving phone keeps the page at its own scale; this one waits.
      if (host.remoteDriven?.(guest)) return;
      zoomGuest(host, state, guest, input.factor);
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
