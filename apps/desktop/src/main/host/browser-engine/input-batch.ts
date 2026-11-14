/**
 * `host/browser/input/batch`: the keys, text and pointer gestures of one agent
 * action run here, in order, each dispatch awaited before the next. Nothing is
 * pipelined: a key that follows a dialog, a hold by the person, a cancel or a
 * pointer press that missed its element is never sent, so the core learns
 * exactly how far the batch got (`completedSteps`) and why it stopped.
 *
 * The drivers are the ones the page's own input path uses (browser/input*.ts):
 * the same key table, the same frame routing and zoom compensation, the same
 * dialog-aware CDP send. This module adds the order, the stop reasons and the
 * counts. The page's facts ride the result through the registry.
 *
 * A person taking the page stops the batch with outcome `userInput` when the
 * call's signal is aborted with a `-32012` HostRpcError as its reason (what the
 * wiring does when the person holds the page), or when a dispatch fails with
 * that error; any other abort is `cancelled`.
 */
import { performance } from 'node:perf_hooks';
import type { WebContents } from 'electron';

import type {
  BrowserInputOutcome,
  BrowserPointerStep,
  HostBrowserInputBatchResult,
  InputStep,
  Precondition,
} from '../../../../../../packages/protocol/src/index.ts';
import { createBrowserHitTarget } from '../../browser/hit-target';
import { createBrowserInputDriver, normalizeModifierMask, normalizeMouseButton } from '../../browser/input';
import { createBrowserInputDispatch } from '../../browser/input-dispatch';
import { cssPoint, type SendBrowserInput } from '../../browser/input-primitives';
import { pause } from '../../browser/settle';
import { createFrameOffsetResolver } from '../../browser/snapshot-frame-offset';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import type { EngineContext, EnginePage, GuestState } from './context';
import { ENGINE_ERROR, preconditionFailed } from './errors';
import { documentIdOf, checkPrecondition } from './precondition';
import { registerEngineMethod } from './registry';

const METHOD = 'host/browser/input/batch';

/** `buttons` bit of each mouse button, as CDP numbers them. */
const BUTTON_BIT = { left: 1, right: 2, middle: 4 } as const;
/** Pointer kinds whose first event presses a button or a contact: their element is guarded. */
const PRESSING_KINDS = new Set(['click', 'dblclick', 'down', 'tap', 'dragTo']);

type Held = { button: keyof typeof BUTTON_BIT; mask: number };

/** The pointer press did not land on the element its hit guard names (or the element could not be guarded). */
class HitGuardMiss extends Error {}

function invalid(what: string): never {
  throw new HostRpcError(HOST_INVALID_PARAMS, `${METHOD} ${what}.`);
}

function finite(value: unknown, what: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${what} must be a number`);
}

/** The steps as the protocol types them, or -32602 naming the first wrong one. */
function parseSteps(value: unknown): InputStep[] {
  if (!Array.isArray(value)) invalid('steps must be an array');
  (value as unknown[]).forEach((raw, index) => {
    const at = `steps[${index}]`;
    if (!raw || typeof raw !== 'object') invalid(`${at} must be an object`);
    const step = raw as Record<string, unknown>;
    switch (step.op) {
      case 'type':
      case 'insertText':
        if (typeof step.text !== 'string') invalid(`${at}.text must be a string`);
        break;
      case 'press':
        if (typeof step.key !== 'string') invalid(`${at}.key must be a string`);
        break;
      case 'pointer':
        if (typeof step.kind !== 'string') invalid(`${at}.kind must be a string`);
        finite(step.x, `${at}.x`);
        finite(step.y, `${at}.y`);
        if (step.kind === 'dragTo' || step.kind === 'swipe') {
          finite(step.toX, `${at}.toX`);
          finite(step.toY, `${at}.toY`);
        }
        break;
      default:
        invalid(`${at}.op must be type, insertText, press or pointer`);
    }
  });
  return value as InputStep[];
}

/** What one batch accumulates besides its steps. */
interface Run {
  dialog: boolean;
  keyEvents: number;
  mouseEvents: number;
}

/** `ControlOrMeta` is the shortcut modifier of the machine the page is on: Command on macOS, Control elsewhere (the core does not know which it is). */
function modifierOfThisHost(modifier: string): string {
  return modifier === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : modifier;
}

export function registerInputBatch(connection: HostConnection, ctx: EngineContext): void {
  // A gesture's routing and a held button outlive one batch: a `down` in one and its `up` in the next belong together.
  const states = new WeakMap<WebContents, GuestState>();
  const held = new WeakMap<WebContents, Held>();
  const stateOf = (guest: WebContents): GuestState => states.get(guest) as GuestState;
  const dispatch = createBrowserInputDispatch({
    cdp: ctx.cdp,
    documentId: (guest) => documentIdOf(stateOf(guest)),
    frames: (guest) => stateOf(guest).cdpSessions,
    frameOffset: createFrameOffsetResolver({ cdp: ctx.cdp, sessions: (guest) => stateOf(guest).cdpSessions }),
  });
  const hitTarget = createBrowserHitTarget({
    cdp: ctx.cdp,
    frames: (guest) => stateOf(guest).cdpSessions,
    pendingDialog: (guest) => Boolean(stateOf(guest).pendingDialog),
  });

  registerEngineMethod(connection, ctx, METHOD, async (params, signal, call) => {
    const steps = parseSteps(params.steps);
    const stopOnDialog = params.stopOnDialog !== false;
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 0;
    const expect = params.expect as Precondition | undefined;
    // The input goes to the page the core decided the batch against: in engine mode one bound to no state is refused.
    if (!expect && ctx.isEngineMode()) throw preconditionFailed('document', call.facts());
    const { guest, state } = call;
    states.set(guest, state);

    const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    const work = timeout ? AbortSignal.any([signal, timeout]) : signal;
    const run: Run = { dialog: false, keyEvents: 0, mouseEvents: 0 };
    const page: EnginePage = { guest, state };

    const send: SendBrowserInput = async (target, method, input, sendSignal, beforeDispatch) => {
      const pressing =
        (method === 'Input.dispatchMouseEvent' && input.type === 'mousePressed') ||
        (method === 'Input.dispatchTouchEvent' && input.type === 'touchStart');
      const outcome = await dispatch(target, method, input, sendSignal, () => {
        // The page may have moved on while the steps before this press ran.
        if (pressing && expect) checkPrecondition(expect, page, call.facts);
        beforeDispatch?.();
      });
      if (method === 'Input.dispatchKeyEvent' || method === 'Input.insertText') run.keyEvents += 1;
      else if (method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchTouchEvent') run.mouseEvents += 1;
      if (outcome === 'dialog') run.dialog = true;
      return outcome;
    };
    const driver = createBrowserInputDriver(send, {
      drags: {
        slots: { for: () => state, peek: () => state },
        evaluate: async (target, expression, evalSignal) => {
          const reply = await ctx.cdp.call<{ result?: { value?: unknown } }>(
            target,
            'Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true, userGesture: true },
            evalSignal
          );
          return reply.result?.value;
        },
      },
    });

    /** The hit guard of a pointer step: armed before the gesture, checked after it. */
    async function armGuard(step: BrowserPointerStep): Promise<(() => Promise<void>) | undefined> {
      const guard = step.hitGuard;
      if (!guard || !PRESSING_KINDS.has(step.kind)) return undefined;
      const refs = state.accessibilityRefs;
      const target = refs?.snapshotId === guard.snapshotId ? refs.refs.get(guard.ref) : undefined;
      if (!target) throw preconditionFailed('snapshot', call.facts());
      try {
        return await hitTarget.guard(guest, target, work);
      } catch (error) {
        work.throwIfAborted();
        throw new HitGuardMiss((error as Error).message);
      }
    }

    async function rawMouse(kind: 'move' | 'down' | 'up', step: BrowserPointerStep): Promise<void> {
      const point = cssPoint({ x: step.x, y: step.y });
      const modifiers = normalizeModifierMask(step.modifiers);
      const current = held.get(guest);
      if (kind === 'down') {
        const button = normalizeMouseButton(step.button);
        const next = { button, mask: BUTTON_BIT[button] | (current?.mask ?? 0) };
        await send(
          guest,
          'Input.dispatchMouseEvent',
          { ...point, type: 'mousePressed', button, buttons: next.mask, clickCount: 1, modifiers },
          work
        );
        held.set(guest, next);
      } else if (kind === 'up') {
        const button = normalizeMouseButton(step.button ?? current?.button);
        const mask = (current?.mask ?? 0) & ~BUTTON_BIT[button];
        await send(
          guest,
          'Input.dispatchMouseEvent',
          { ...point, type: 'mouseReleased', button, buttons: mask, clickCount: 1, modifiers },
          work
        );
        if (mask) held.set(guest, { button: current?.button ?? button, mask });
        else held.delete(guest);
      } else {
        await send(
          guest,
          'Input.dispatchMouseEvent',
          { ...point, type: 'mouseMoved', button: current?.button ?? 'none', buttons: current?.mask ?? 0, modifiers },
          work
        );
      }
    }

    async function pointer(step: BrowserPointerStep): Promise<void> {
      const at = { x: step.x, y: step.y };
      switch (step.kind) {
        case 'move':
        case 'down':
        case 'up':
          return rawMouse(step.kind, step);
        case 'hover':
          return driver.hoverAt(guest, step.x, step.y, work);
        case 'click':
        case 'dblclick':
          return driver.clickAt(
            guest,
            step.x,
            step.y,
            step.kind === 'dblclick' ? 2 : 1,
            normalizeMouseButton(step.button),
            normalizeModifierMask(step.modifiers),
            work
          );
        case 'wheel':
          return driver.scrollAt(guest, at, step.deltaX ?? 0, step.deltaY ?? 0, work);
        case 'tap':
          return driver.tapAt(guest, at, work);
        case 'dragTo':
          return driver.dragAt(guest, at, { x: step.toX as number, y: step.toY as number }, work);
        case 'swipe':
          return driver.swipeAt(guest, at, { x: step.toX as number, y: step.toY as number }, work);
        default:
          return invalid(`pointer kind ${String((step as { kind: unknown }).kind)} is not known`);
      }
    }

    async function guardedPointer(step: BrowserPointerStep): Promise<void> {
      const finishGuard = await armGuard(step);
      try {
        await pointer(step);
      } catch (error) {
        // The step failed on its own: the guard is only cleaned up, its verdict does not replace the error.
        await finishGuard?.().catch(() => undefined);
        throw error;
      }
      try {
        await finishGuard?.();
      } catch (error) {
        work.throwIfAborted();
        throw new HitGuardMiss((error as Error).message);
      }
    }

    async function runStep(step: InputStep): Promise<void> {
      switch (step.op) {
        case 'type': {
          if (!step.delayMs) return driver.typeText(guest, step.text, work);
          // A pause between characters: one driver call per character, so a dialog or a cancel stops the rest.
          for (const character of step.text) {
            await driver.typeText(guest, character, work);
            if (run.dialog && stopOnDialog) return;
            await pause(step.delayMs, work);
          }
          return;
        }
        case 'insertText':
          await send(guest, 'Input.insertText', { text: step.text }, work);
          return;
        case 'press': {
          const chord = [...(step.modifiers ?? []).map(modifierOfThisHost), step.key].join('+');
          for (let n = 0; n < Math.max(1, step.repeat ?? 1); n += 1) {
            await driver.pressKey(guest, chord, work);
            if (run.dialog && stopOnDialog) return;
          }
          return;
        }
        default:
          return guardedPointer(step);
      }
    }

    const started = performance.now();
    let outcome: BrowserInputOutcome = 'completed';
    let completed = 0;
    try {
      // Each event is marked as the agent's while it is dispatched (sendCdpInput, agent-input.ts), never the
      // pauses between steps: a person's input during a slow batch still counts as theirs and stops it.
      for (const step of steps) {
        work.throwIfAborted();
        if (state.pendingDialog && stopOnDialog) {
          run.dialog = true;
          break;
        }
        await runStep(step);
        if (run.dialog && stopOnDialog) break;
        completed += 1;
      }
      if (run.dialog && stopOnDialog) outcome = 'dialog';
    } catch (error) {
      if (signal.aborted) {
        const reason = signal.reason;
        outcome = reason instanceof HostRpcError && reason.code === ENGINE_ERROR.userInput ? 'userInput' : 'cancelled';
      } else if (timeout?.aborted) {
        throw new HostRpcError(
          ENGINE_ERROR.failed,
          `${METHOD} did not finish within ${timeoutMs} ms; ${completed} of ${steps.length} steps ran.`
        );
      } else if (error instanceof HostRpcError && error.code === ENGINE_ERROR.userInput) {
        outcome = 'userInput';
      } else if (error instanceof HitGuardMiss) {
        outcome = 'hitGuard';
      } else {
        throw error;
      }
    }
    const result: Omit<HostBrowserInputBatchResult, 'facts'> = {
      outcome,
      completedSteps: completed,
      timing: { inputMs: performance.now() - started, keyEvents: run.keyEvents, mouseEvents: run.mouseEvents },
    };
    return result;
  });
}
