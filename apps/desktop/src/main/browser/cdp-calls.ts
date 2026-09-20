/** Commands against a guest: the default-timeout `call`, dialog-aware input
 *  dispatch, and `Runtime.evaluate` with page exceptions turned into errors. */
import type { WebContents } from 'electron';

import { CDP_REQUEST_TIMEOUT_MS } from './command';
import type { BrowserCdpSend } from './cdp-session-init';
import type { BrowserGuestStateStore } from './guest-state';
import { redactBrowserText } from './redaction';
import { pause } from './settle';

export interface BrowserCdpCallOptions {
  beforeDispatch?: () => void;
  /** Address a child target (frame, worker) instead of the root session. */
  sessionId?: string;
  timeoutMs?: number;
}

export interface CdpCallsHost {
  state: BrowserGuestStateStore;
  sendCdp: BrowserCdpSend;
  guestDebugger(guest: WebContents): Promise<Electron.Debugger>;
}

export function createBrowserCdpCalls(host: CdpCallsHost) {
  const { state, sendCdp, guestDebugger } = host;

  /** An open alert, confirm or prompt freezes the page's main thread, so every
   *  later call dies on its deadline with a message that explains nothing and
   *  invites a retry that will time out again. Name the dialog instead: it has
   *  to be answered before anything else on this page can run. */
  function explainPendingDialog(guest: WebContents, error: unknown): unknown {
    const dialog = state.peek(guest)?.pendingDialog;
    if (!dialog || !(error instanceof Error) || !/ timed out after \d+ms$/.test(error.message)) return error;
    return new Error(
      `${error.message} — an open ${dialog.type} dialog is blocking this page: ${JSON.stringify(dialog.message)}. ` +
        'Answer it with handle_dialog; the page cannot run anything else until then.'
    );
  }

  /** One command against a guest: resolves the attached debugger and applies
   *  the default request timeout. Page services reach CDP through this. */
  async function call<T>(
    guest: WebContents,
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    options: BrowserCdpCallOptions = {}
  ): Promise<T> {
    try {
      return await sendCdp<T>(
        guest,
        await guestDebugger(guest),
        method,
        params,
        options.timeoutMs ?? CDP_REQUEST_TIMEOUT_MS,
        signal,
        options.sessionId,
        options.beforeDispatch
      );
    } catch (error) {
      throw explainPendingDialog(guest, error);
    }
  }

  /** Input commands can remain pending while a JavaScript dialog blocks its
   *  event handler. Return control as soon as the dialog event arrives so the
   *  caller can issue handle_dialog instead of waiting for the CDP timeout. */
  async function sendCdpInput(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    sessionId?: string,
    beforeDispatch?: () => void
  ): Promise<'completed' | 'dialog'> {
    const dispatch = sendCdp<void>(
      guest,
      cdp,
      method,
      params,
      CDP_REQUEST_TIMEOUT_MS,
      signal,
      sessionId,
      beforeDispatch
    );
    const outcome = dispatch.then(
      () => ({ done: true as const, error: null }),
      (error: unknown) => ({ done: true as const, error })
    );
    for (;;) {
      const next = await Promise.race([outcome, pause(25, signal).then(() => ({ done: false as const, error: null }))]);
      if (next.done) {
        if (next.error) throw next.error;
        return 'completed';
      }
      if (state.for(guest).pendingDialog) return 'dialog';
    }
  }

  async function evaluate<T>(
    guest: WebContents,
    expression: string,
    signal?: AbortSignal,
    timeoutMs = CDP_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const cdp = await guestDebugger(guest);
    const response = await sendCdp<{
      result?: { value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      guest,
      cdp,
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        includeCommandLineAPI: true,
        userGesture: true,
      },
      timeoutMs,
      signal
    );
    if (response.exceptionDetails) {
      const detail =
        response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'page script failed';
      // The message alone does not say which line of the caller's script threw,
      // so keep the innermost stack frame with it on the same line.
      const [message, ...stack] = detail.split('\n');
      const frame = stack.map((line) => line.trim()).find((line) => line.startsWith('at '));
      throw new Error(redactBrowserText(frame ? `${message} (${frame.slice(3)})` : message));
    }
    return response.result?.value as T;
  }

  return { call, sendCdpInput, evaluate };
}
