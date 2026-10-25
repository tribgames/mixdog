/** Local, user-initiated page controls: tab chrome, prompt answers, resize,
 *  native recovery, navigation, and input dispatched through CDP under the
 *  document guard that ties every event to the page the user still sees. */
import type { WebContents } from 'electron';
import type { DesktopBrowserPageControl, DesktopBrowserTabControlResult } from '../../shared/contract';
import { createBrowserInputDriver } from './input';
import { controlSessionTab, isSessionTabControl } from './tabs-close-result';
import { normalizePageUrl } from './url-policy';
import { BROWSER_DIALOG_BLOCKING, browserTypingInput } from '../../shared/browser-input-policy';
import { browserDocumentId } from './guest-state';
import type { BrowserPageSurfaceHost } from './page-surface';
import type { PageSurfaceState } from './page-surface-state';
import { setBrowserPageZoom } from './page-zoom';

/** Float noise from Chromium's zoom-level round trip, not a new zoom. */
const ZOOM_EPSILON = 0.001;

type LeaveHost = Pick<BrowserPageSurfaceHost, 'leave'>;

/** Run a person's request that may leave the page; a page veto is asked
 *  about, and leaving runs `repeat` (see leave-confirmation). */
function requestLeave(
  host: LeaveHost,
  guest: WebContents,
  run: () => boolean | Promise<boolean>,
  repeat?: () => boolean | Promise<boolean>
): void {
  if (host.leave) host.leave.request(guest, run, repeat);
  else run();
}

/** Step back (-1) or forward (1) in the page's history; false when there is
 *  no entry that way, so nothing was started. */
function goInHistory(guest: WebContents, step: -1 | 1): boolean {
  const history = guest.navigationHistory;
  if (step < 0 ? !history.canGoBack() : !history.canGoForward()) return false;
  if (step < 0) history.goBack();
  else history.goForward();
  return true;
}

/** A person's toolbar navigation, from the pane or a paired client: an
 *  admitted URL, history, reload or stop. Everything but stop may leave the
 *  page, so each is a leave request. */
export function navigatePage(
  host: LeaveHost,
  guest: WebContents,
  action: { type: 'navigate'; url: string } | { type: 'back' | 'forward' | 'reload' | 'stop' }
): void {
  switch (action.type) {
    case 'navigate': {
      const { url } = action;
      requestLeave(host, guest, () => {
        void guest.loadURL(url).catch(() => {});
        return true;
      });
      return;
    }
    case 'back':
    case 'forward': {
      const step = action.type === 'back' ? -1 : 1;
      requestLeave(host, guest, () => goInHistory(guest, step));
      return;
    }
    case 'reload':
      requestLeave(host, guest, () => {
        guest.reload();
        return true;
      });
      return;
    case 'stop':
      guest.stop();
  }
}

/** Human page input through CDP under the caller's document guard. Shared by
 *  the local pane and paired remote clients so both behave identically. */
export function createPageInputDispatcher(
  host: Pick<
    BrowserPageSurfaceHost,
    'state' | 'cdp' | 'dispatchInput' | 'urlPolicy' | 'assertUrl' | 'dialogOwner' | 'leave'
  >
) {
  /** Each page's last press: the first half of the click its release completes. */
  const presses = new WeakMap<WebContents, Record<string, unknown>>();
  return async function dispatchPageInput(
    guest: WebContents,
    input: DesktopBrowserPageControl,
    assertCurrent: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    const assertUnblocked = () => {
      if (host.state.for(guest).pendingDialog || host.dialogOwner?.(guest)) throw new Error(BROWSER_DIALOG_BLOCKING);
    };
    const assertDispatch = () => {
      assertCurrent();
      assertUnblocked();
    };
    await host.cdp.waitForIdle(guest, signal);
    assertDispatch();
    host.state.invalidateInteraction(guest);
    // A click or keystroke may leave state only this document holds (a half
    // filled form), so the page is no longer safe to unload and restore.
    // The press or key is the person's gesture: a window it opens is theirs.
    if (browserTypingInput(input) || (input.type === 'pointer' && input.phase === 'mousePressed')) {
      host.state.for(guest).userInput = true;
      host.state.for(guest).actor = 'person';
      // This gesture, not an earlier dialog answer, is what a window it opens
      // comes from (Chromium reports it per window).
      host.state.for(guest).personDialogAnswerAt = undefined;
    }
    /** Input sent under `guard`, revalidated right before every event. */
    const sender =
      (guard: () => void) =>
      async (target: WebContents, method: string, params: Record<string, unknown>, inputSignal?: AbortSignal) => {
        if (host.dispatchInput) return host.dispatchInput(target, method, params, inputSignal, guard);
        const debuggerInstance = await host.cdp.guestDebugger(target);
        guard();
        // The CDP transport may itself wait for cleanup after initialization.
        // Revalidate in that transport, with no await before the actual send.
        return host.cdp.sendCdpInput(target, debuggerInstance, method, params, inputSignal, undefined, guard);
      };
    type Send = ReturnType<typeof sender>;
    const send = sender(assertDispatch);
    const mouseWith = (through: Send) => (params: Record<string, unknown>, inputSignal?: AbortSignal) =>
      through(guest, 'Input.dispatchMouseEvent', params, inputSignal);
    const mouse = mouseWith(send);
    /** A click or key press may make the page leave by itself (a link, a
     *  submit button, Enter in a form), so it is a leave request like a
     *  toolbar one; leaving past the page's veto repeats the whole gesture.
     *  The repeat runs when the card is answered, which is checked against
     *  the document shown then — a same-document move since the gesture
     *  keeps the card — so it is bound to that document, not the gesture's. */
    const gesture = async (dispatch: () => Promise<unknown>, repeat: (through: Send) => Promise<unknown>) => {
      const started = (sending: Promise<unknown>) =>
        sending.then(
          () => true,
          () => false
        );
      let sent: Promise<unknown> = Promise.resolve();
      requestLeave(
        host,
        guest,
        () => {
          sent = dispatch();
          return started(sent);
        },
        () => {
          const documentId = browserDocumentId(host.state, guest);
          return started(
            repeat(
              sender(() => {
                if (guest.isDestroyed() || browserDocumentId(host.state, guest) !== documentId) {
                  throw new Error('Browser page changed; input was not sent.');
                }
                assertUnblocked();
              })
            )
          );
        }
      );
      await sent;
    };
    switch (input.type) {
      case 'navigate': {
        const url = normalizePageUrl(input.url, host.urlPolicy);
        await host.assertUrl(url, true);
        // As an agent's navigate does: a fresh tab is still committing its
        // blank first document, and a debugger attaching under the person's
        // navigation crashes the renderer.
        await host.cdp.guestDebugger(guest);
        assertCurrent();
        navigatePage(host, guest, { type: 'navigate', url });
        break;
      }
      case 'back':
      case 'forward':
        navigatePage(host, guest, input);
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
          await gesture(
            // Each key sequence retains its own document guard across every dispatch.
            () => createBrowserInputDriver(send, { allowClipboard: true }).pressKey(guest, input.key, signal),
            (through) => createBrowserInputDriver(through, { allowClipboard: true }).pressKey(guest, input.key)
          );
        }
        break;
      case 'pointer': {
        const event = {
          type: input.phase,
          x: input.x,
          y: input.y,
          button: input.button,
          buttons: input.buttons,
          modifiers: input.modifiers,
          clickCount: input.clickCount,
        };
        if (input.phase === 'mousePressed') presses.set(guest, event);
        if (input.phase !== 'mouseReleased') {
          await mouse(event, signal);
          break;
        }
        const press = presses.get(guest);
        presses.delete(guest);
        await gesture(
          () => mouse(event, signal),
          async (through) => {
            const replay = mouseWith(through);
            if (press) await replay(press);
            await replay(event);
          }
        );
        break;
      }
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

/** Set a page's zoom factor, for that page alone (page-zoom.ts); the factor
 *  it already has changes nothing. */
export function zoomGuest(
  host: Pick<BrowserPageSurfaceHost, 'state'>,
  state: Pick<PageSurfaceState, 'invalidateGeometry'>,
  guest: WebContents,
  factor: number
): void {
  if (Math.abs(guest.getZoomFactor() - factor) < ZOOM_EPSILON) return;
  state.invalidateGeometry(guest);
  host.state.invalidateInteraction(guest);
  setBrowserPageZoom(guest, factor);
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
      // The prompts route a dialog answer to whichever page's dialog blocks
      // this one (local-prompts).
      await host.prompts.answer(guest, input, assertCurrent, signal);
      host.state.invalidateInteraction(host.state.dialogOwner(guest) ?? guest);
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
    if (input.type === 'reload' || input.type === 'stop') {
      host.state.invalidateInteraction(guest);
      navigatePage(host, guest, input);
      return;
    }
    // A click or key in the page is the user taking it, not a stand-in.
    if (
      (input.type === 'pointer' && input.phase === 'mousePressed') ||
      // An address typed into the bar counts even if the load then fails.
      input.type === 'navigate' ||
      input.type === 'key' ||
      input.type === 'text' ||
      input.type === 'composition' ||
      input.type === 'composition-end'
    ) {
      host.userTouched?.(sessionId, guest);
    }
    await dispatchPageInput(guest, input, assertCurrent, signal);
  };
}
