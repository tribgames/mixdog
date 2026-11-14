/**
 * The sign-in half of the engine lane: what the desktop keeps of the pages' sign-in state and answers for the core's engine
 * (`host/browser/signIn`, `host/browser/credentials/fill`, `host/browser/turn`). The core's engine runs the command and builds the
 * reply; the vault, the saved logins' automatic sign-in and the linked identity of a provider flow stay with the desktop, which
 * alone can read them, and these methods are the engine's way to them:
 *
 *  - `signIn` `beforeAction`: a click, fill or type is about to be sent; the field the agent names on a provider's sign-in page is
 *    noted (`linkedSignIn.beforeAction`).
 *  - `signIn` `afterCommand`: a page that asks for a sign-in a saved login fits is signed in once per site and turn
 *    (`autoSignIn.afterCommand`, unless the command filled a saved account itself); the answer is the saved-login note, which the
 *    engine puts ahead of a fresh observation, and the line of the identity a provider flow last used here (`replyLine`). The flow
 *    observes the page the way the command runner's `observe` did: a snapshot capture of the page, taken when the flow asks for one.
 *  - `credentials/fill`: `fill` with `savedAccount`; the stored login of the page's origin is written into the page and the
 *    form's answer (whether the password was taken) goes back.
 *  - `turn`: the session's turn ended (what the sign-in flows remember per turn goes, and the untouched blank page the agent left
 *    behind is closed: `finishBrowserTurn`), or the session was released.
 */
import type { WebContents } from 'electron';

import { SAVED_SIGN_IN_DONE, SAVED_SIGN_IN_NEEDS_USER } from '../../browser/auto-sign-in';
import { browserSessionId } from '../../browser/session-registry';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import type { EngineContext } from './context';
import { registerEngineMethod, registerEngineSessionMethod } from './registry';
import type { SnapshotHost } from './snapshot';

/** What a stored login's fill reports (browser/credential-autofill.ts). */
export interface FilledLogin {
  usernameFilled: boolean;
  passwordFilled: boolean;
  reason?: string;
}

/** What the sign-in methods reach: the sign-in flows of browser/host-agent.ts and the session's turn bookkeeping. */
export interface SignInDeps {
  /** `linkedSignIn.beforeAction`. */
  beforeAction(guest: WebContents, action: string, command: Record<string, unknown>, signal?: AbortSignal): void | Promise<void>;
  /** `autoSignIn.afterCommand`: the reply it would send instead (its text begins with the saved-login note), or null. */
  afterCommand(input: {
    guest: WebContents;
    sessionId: string;
    turnId: number;
    signal?: AbortSignal;
    observe: () => Promise<{ text: string }>;
  }): Promise<{ text: string } | null>;
  /** `linkedSignIn.replyLine`. */
  replyLine(input: { guest: WebContents; sessionId: string; turnId: number }): Promise<string>;
  /** The stored login of the page's origin, written into the page (`storedCredentialFill`). */
  fillStored(guest: WebContents, account: string, signal?: AbortSignal): Promise<FilledLogin>;
  /** A command of the turn ran: the session is live. */
  beginTurn(sessionId: string, turn: number): void;
  /** `finishBrowserTurn`: how many pages the host's own turn bookkeeping closed. */
  finishTurn(sessionId: string, turn: number, aborted: boolean): number;
  /** `taskLifecycle.forget`. */
  forget(sessionId: string): void;
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sessionOf(params: Record<string, unknown>): string {
  try {
    return browserSessionId(params.sessionId);
  } catch (error) {
    throw new HostRpcError(HOST_INVALID_PARAMS, (error as Error).message);
  }
}

/** The turn the call names; 0 (no turn) when it names none. */
function turnOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** The saved-login line an automatic sign-in put ahead of its observation (command-runner.ts `savedSignInNote`). */
export function savedSignInNote(text: string): string {
  const note = text.split('\n\n')[0];
  return note.startsWith(SAVED_SIGN_IN_DONE) || note.startsWith(SAVED_SIGN_IN_NEEDS_USER) ? note : '';
}

/** Registers `host/browser/signIn`, `host/browser/credentials/fill` and `host/browser/turn`. */
export function registerSignIn(
  connection: HostConnection,
  ctx: EngineContext,
  deps: SignInDeps,
  snapshot: Pick<SnapshotHost, 'captureSnapshotPayload'>
): void {
  registerEngineMethod(connection, ctx, 'host/browser/signIn', async (params, signal, page) => {
    const sessionId = sessionOf(params);
    const turnId = turnOf(params.turn);
    const { guest } = page;
    deps.beginTurn(sessionId, turnId);
    if (params.op === 'beforeAction') {
      const action = typeof params.action === 'string' ? params.action : '';
      await deps.beforeAction(guest, action, isObject(params.command) ? params.command : {}, signal);
      return {};
    }
    if (params.op !== 'afterCommand') {
      throw new HostRpcError(HOST_INVALID_PARAMS, 'signIn op must be beforeAction or afterCommand.');
    }
    let note = '';
    if (params.explicitFill !== true) {
      // The flow's observation is a capture of the page (`reply.snapshotResult`): its text is never read, the engine takes its own
      // observation behind the note. A capture the page refused (a dialog opened meanwhile) leaves the flow's reading as it was.
      const observe = async (): Promise<{ text: string }> => {
        try {
          await snapshot.captureSnapshotPayload(guest, { action: 'snapshot' }, signal);
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          deps.onDiagnostic?.('browser-sign-in-observe-failed', { error: (error as Error)?.message ?? String(error) });
        }
        return { text: '' };
      };
      const signedIn = await deps.afterCommand({ guest, sessionId, turnId, signal, observe });
      note = signedIn ? savedSignInNote(signedIn.text) : '';
    }
    let line = '';
    try {
      line = await deps.replyLine({ guest, sessionId, turnId });
    } catch (error) {
      // The reply goes out without the line either way. The one expected failure is the page closing while its record is
      // read; any other (an unreadable store, ...) is reported, never silently dropped.
      if (!guest.isDestroyed()) {
        deps.onDiagnostic?.('browser-linked-sign-in-reply-failed', { error: (error as Error)?.message ?? String(error) });
      }
    }
    return { ...(note ? { note } : {}), ...(line ? { line } : {}) };
  });

  registerEngineMethod(connection, ctx, 'host/browser/credentials/fill', async (params, signal, page) => {
    if (typeof params.account !== 'string') {
      throw new HostRpcError(HOST_INVALID_PARAMS, 'credentials/fill needs an account.');
    }
    const filled = await deps.fillStored(page.guest, params.account, signal);
    return {
      usernameFilled: filled.usernameFilled === true,
      passwordFilled: filled.passwordFilled === true,
      ...(filled.reason ? { reason: filled.reason } : {}),
    };
  });

  registerEngineSessionMethod(connection, ctx, 'host/browser/turn', async (params) => {
    const sessionId = sessionOf(params);
    if (params.op === 'forget') {
      deps.forget(sessionId);
      return { closed: 0 };
    }
    if (params.op !== 'end') throw new HostRpcError(HOST_INVALID_PARAMS, 'turn op must be end or forget.');
    const turn = turnOf(params.turn);
    if (!turn) throw new HostRpcError(HOST_INVALID_PARAMS, 'turn end needs the turn.');
    return { closed: deps.finishTurn(sessionId, turn, params.aborted === true) };
  });
}
