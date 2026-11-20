/**
 * The effect port of app-owned Electron renderer input: the only code that reaches a renderer's debugger input channel or its
 * text insertion for Computer Use. Callers get typed input operations, never the debugger.
 *
 * - Every submission is arbitrated against the scope endpoint in the same synchronous turn that hands it to Electron
 *   (`scope.commit()` then `sendCommand`), so a revocation, which runs in a task of its own, either precedes it (refused) or
 *   follows the hand-over. Waits (the window's queue, a reply) hold nothing; the next event is arbitrated again.
 * - A press handed over is recorded as a receipt (this operation, the renderer, the key or button) before its reply is
 *   awaited, so an error, a lost reply or a cancellation keeps it owned. A release is a release only by consuming a receipt:
 *   the port then sends the release it recorded (the press's own key fields, or the button at its last accepted point), never
 *   the caller's payload, and that alone goes out after the revocation. A release without a receipt is an ordinary
 *   submission. The receipts left are let go of at the revocation (the scope's signal) and at the operation's exit.
 *
 * Not retracted: input already handed to Electron before the revocation.
 */
import type { WebContents } from 'electron';
import type { BrowserInputOutcome, SendBrowserInput } from '../../browser/input-primitives';

/** The scope a renderer input operation runs under: mandatory for every operation. */
export interface ScopeEndpoint {
  /** Throws once the scope admits no new input; run in the same synchronous turn as each hand-over. */
  commit(): void;
  /** Aborts at the revocation, when the port lets go of the presses it holds (an operation awaiting a reply included). */
  readonly signal: AbortSignal;
  /** The scope's accounting of a call handed over, until it settles; absent where the scope reports nothing. */
  track?(reply: Promise<unknown>): void;
}

/** The typed input one operation may submit. */
export interface RendererInput {
  /** The key and mouse events the shared keyboard and pointer builders produce; any other method is refused. */
  readonly send: SendBrowserInput;
  /** Literal text through the renderer's own insertion. */
  insertText(text: string): Promise<void>;
}

const KEY = 'Input.dispatchKeyEvent';
const MOUSE = 'Input.dispatchMouseEvent';
const TEXT = 'Input.insertText';

interface Receipt {
  method: typeof KEY | typeof MOUSE;
  /** The release the press recorded; a held button's point follows the accepted motion. */
  release: Record<string, unknown>;
}

/** The tail of each window's queued input operations: one operation at a time per renderer, so another session never detaches
 *  the debugger between a press and its release. */
const operationTails = new WeakMap<WebContents, Promise<unknown>>();

/** What a key event holds: its key fields, never its type, text or modifiers. */
function keyIdentity(params: Record<string, unknown>): string {
  return `key:${String(params.code)}:${String(params.key)}:${String(params.windowsVirtualKeyCode)}`;
}

function buttonIdentity(params: Record<string, unknown>): string {
  return `button:${String(params.button)}`;
}

/** Runs `work` with typed input to `contents` under `scope`, after the operations queued before it on this renderer. */
export function runRendererInput<T>(
  contents: WebContents,
  scope: ScopeEndpoint,
  work: (input: RendererInput) => Promise<T>
): Promise<T> {
  const previous = operationTails.get(contents) ?? Promise.resolve();
  const run = previous.then(() => attachedOperation(contents, scope, work));
  operationTails.set(
    contents,
    run.catch(() => undefined)
  );
  return run;
}

async function attachedOperation<T>(
  contents: WebContents,
  scope: ScopeEndpoint,
  work: (input: RendererInput) => Promise<T>
): Promise<T> {
  // Refused before the debugger is touched: an operation queued behind the revocation attaches nothing.
  scope.commit();
  const cdp = contents.debugger;
  // Attached at the first event and detached at the exit, only when this operation attached it.
  let attachedHere = false;
  const held = new Map<string, Receipt>();
  /** Holds the cleanup already let go of: an operation's own release of one of them then sends nothing again. */
  const drained = new Set<string>();
  const pending: Promise<unknown>[] = [];
  const handOver = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (!cdp.isAttached()) {
      cdp.attach('1.3');
      attachedHere = true;
    }
    const reply = cdp.sendCommand(method, params);
    scope.track?.(reply);
    pending.push(reply.catch(() => undefined));
    return reply;
  };
  const drain = (): void => {
    for (const [identity, receipt] of held) {
      held.delete(identity);
      drained.add(identity);
      if (!contents.isDestroyed()) {
        try {
          handOver(receipt.method, receipt.release);
        } catch {
          // A renderer whose debugger is gone holds nothing any more.
        }
      }
    }
  };
  const completed = async (reply: Promise<unknown>): Promise<BrowserInputOutcome> => {
    await reply;
    return 'completed';
  };
  /** An ordinary submission: admitted in the turn it is handed over. */
  const submit = (method: string, params: Record<string, unknown>): Promise<BrowserInputOutcome> => {
    scope.commit();
    return completed(handOver(method, params));
  };
  const press = (
    identity: string,
    method: typeof KEY | typeof MOUSE,
    params: Record<string, unknown>,
    release: Record<string, unknown>
  ) => {
    scope.commit();
    const reply = handOver(method, params);
    held.set(identity, { method, release });
    drained.delete(identity);
    return completed(reply);
  };
  const release = (identity: string, method: string, params: Record<string, unknown>): Promise<BrowserInputOutcome> => {
    const receipt = held.get(identity);
    if (receipt) {
      held.delete(identity);
      return completed(handOver(receipt.method, receipt.release));
    }
    if (drained.delete(identity)) return Promise.resolve('completed');
    return submit(method, params);
  };
  const send: SendBrowserInput = async (guest, method, params) => {
    if (guest !== contents) throw new Error('renderer input names another window');
    const type = params.type;
    if (method === TEXT) return submit(TEXT, { text: String(params.text ?? '') });
    if (method === KEY) {
      if (type === 'rawKeyDown' || type === 'keyDown') {
        const { code, key, windowsVirtualKeyCode, nativeVirtualKeyCode, modifiers } = params;
        return press(keyIdentity(params), KEY, params, {
          type: 'keyUp',
          code,
          key,
          windowsVirtualKeyCode,
          nativeVirtualKeyCode,
          modifiers,
        });
      }
      if (type === 'keyUp') return release(keyIdentity(params), KEY, params);
      if (type === 'char') return submit(KEY, params);
    } else if (method === MOUSE) {
      if (type === 'mousePressed') {
        const { x, y, button, clickCount, modifiers } = params;
        return press(buttonIdentity(params), MOUSE, params, {
          type: 'mouseReleased',
          x,
          y,
          button,
          clickCount,
          modifiers,
        });
      }
      if (type === 'mouseReleased') return release(buttonIdentity(params), MOUSE, params);
      if (type === 'mouseMoved' || type === 'mouseWheel') {
        const outcome = submit(MOUSE, params);
        // Accepted motion moves the point a held button is let go at, as a person's drag does.
        if (type === 'mouseMoved') {
          for (const receipt of held.values()) {
            if (receipt.method === MOUSE) Object.assign(receipt.release, { x: params.x, y: params.y });
          }
        }
        return outcome;
      }
    }
    throw new Error(`renderer input does not offer ${method} ${String(type)}`);
  };
  const input: RendererInput = {
    send,
    async insertText(text) {
      scope.commit();
      const inserted = contents.insertText(text);
      scope.track?.(inserted);
      await inserted;
    },
  };
  const signal = scope.signal;
  signal?.addEventListener('abort', drain, { once: true });
  try {
    return await work(input);
  } finally {
    signal?.removeEventListener('abort', drain);
    drain();
    await Promise.all(pending);
    if (attachedHere && !contents.isDestroyed() && cdp.isAttached()) cdp.detach();
  }
}
