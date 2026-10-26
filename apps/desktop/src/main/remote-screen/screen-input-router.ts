/**
 * The one serialized path every screen input, backend switch and release of
 * one session takes to a desktop. Two backends can inject: `desktop` (the
 * Windows input host on the ordinary desktop) and `secure` (the secure-desktop
 * helper).
 *
 * - Presses per backend, with origin: each press is recorded under the backend
 *   that injected it and the desktop it landed on (Windows session id +
 *   desktop), keyed by backend + origin + key. Its release goes back only
 *   through that backend, and only while that backend reports the same
 *   identity, so it never reaches another session or desktop.
 * - Released at defined points, then forgotten: `releaseAll()` (stop, revoke,
 *   downgrade, demote, viewer leave, `screen-release`) and `switchTo()` (the
 *   previous backend's presses, before the switch). A press its backend can't
 *   deliver at that moment (unreachable, on another desktop, a failed or
 *   abandoned send) is dropped and counted through `onDropped`; nothing is
 *   kept for later.
 * - Serialized: input, switches and releases run strictly in order, one at a
 *   time, so a release always follows the in-flight command it must undo.
 * - Cancellable: `cancel()` bumps a generation; queued input from before it is
 *   dropped when its turn comes, a multi-command plan stops between commands,
 *   and AltGr text stops before the text and before each modifier re-press.
 *   Releases are never cancelled.
 * - Abandonable: `abandon()` (the session's stop deadline) fails every
 *   in-flight and later backend call at once, so a backend that stopped
 *   answering cannot hold the queue.
 * - Idempotent: releasing with nothing held sends nothing.
 */
import { holdKeyOf, isHoldDown, releaseCommandFor } from './screen-input-dispatch';
import type { ScreenHostCommand } from './screen-input-host';

export type ScreenInputBackendId = 'desktop' | 'secure';

/** Where an injected press landed: the Windows session and the desktop in it.
 *  `desktop` is backend-scoped: the input host reports the input desktop's
 *  object name (lower-cased, e.g. `default`), the helper its desktop kind. */
export interface ScreenDesktopIdentity {
  session: number;
  desktop: string;
}

/** A press a backend injected and has not released: its release command and
 *  the desktop it landed on. */
interface HeldPress {
  release: ScreenHostCommand;
  origin: ScreenDesktopIdentity;
}

export interface ScreenInputBackend {
  /** Resolves once the desktop accepted the command; rejects otherwise. */
  send(command: ScreenHostCommand): Promise<void>;
  /** The desktop a command sent now would land on; null while unknown or
   *  unreachable (then no press is made and no release is delivered). */
  identity(): ScreenDesktopIdentity | null;
}

export type ScreenRouteOutcome = 'applied' | 'rejected';

/** Hooks run inside a switch's turn, so activation and the backend change are
 *  one atomic step relative to input. */
export interface ScreenSwitchHooks {
  before?(): Promise<void>;
  after?(): Promise<void>;
}

const BACKENDS: readonly ScreenInputBackendId[] = ['desktop', 'secure'];

/** Ctrl, Alt and Win (generic and sided). Text typed while one of them is held
 *  would fire a shortcut instead of typing. */
const SHORTCUT_MODIFIER_VKS: ReadonlySet<number> = new Set([0x11, 0x12, 0x5b, 0x5c, 0xa2, 0xa3, 0xa4, 0xa5]);
/** AltGr: Windows reports it as Right Alt, with Left Ctrl synthesized beside it. */
const ALTGR_RIGHT_ALT = 0xa5;
const ALTGR_VKS: ReadonlySet<number> = new Set([0xa2, ALTGR_RIGHT_ALT]);

export const sameDesktopIdentity = (a: ScreenDesktopIdentity | null, b: ScreenDesktopIdentity | null): boolean =>
  a !== null && b !== null && a.session === b.session && a.desktop === b.desktop;

/** A held press's map key within its backend: origin plus key/button. */
const heldKey = (origin: ScreenDesktopIdentity, hold: string): string =>
  `${origin.session}|${origin.desktop}|${hold}`;

/** How a text command is typed given the modifiers this backend holds:
 *  `plain` (none held), `altgr` (only AltGr held, on the current desktop:
 *  lifted around the text and restored after), or `refused`. */
type TextModifiers = { mode: 'plain' } | { mode: 'refused' } | { mode: 'altgr'; lifts: string[] };

export class ScreenInputRouter {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private active: ScreenInputBackendId | null = null;
  private abandoned = false;
  private readonly abandonWaiters = new Set<() => void>();
  /** Presses each backend injected and has not yet released, keyed by origin
   *  + key (`heldKey`): the same key pressed on two desktops is two presses. */
  private readonly held: Record<ScreenInputBackendId, Map<string, HeldPress>> = {
    desktop: new Map(),
    secure: new Map(),
  };

  constructor(
    private readonly backends: Record<ScreenInputBackendId, ScreenInputBackend>,
    /** A release point dropped `count` presses `backend` could not release. */
    private readonly onDropped: (backend: ScreenInputBackendId, count: number) => void = () => {}
  ) {}

  activeBackend(): ScreenInputBackendId | null {
    return this.active;
  }

  /** Any press is held. */
  holdsInput(): boolean {
    return BACKENDS.some((id) => this.held[id].size > 0);
  }

  /** Queued input from before this call is dropped; releases still run. */
  cancel(): void {
    this.generation += 1;
  }

  /** No backend is sent anything more: in-flight calls fail now, later ones
   *  fail at once, so the releases that follow are dropped. Permanent. */
  abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    this.generation += 1;
    for (const fail of [...this.abandonWaiters]) fail();
    this.abandonWaiters.clear();
  }

  /**
   * Injects a plan through the active backend. `allowed` is re-read when the
   * plan's turn comes and before each command (and inside AltGr text), so a
   * stop, revoke or downgrade that lands while it waits drops it. An up is
   * sent only for a press this backend holds on its current desktop; any
   * other up is skipped (it is not ours to lift here).
   */
  dispatch(commands: ScreenHostCommand[], allowed: () => boolean): Promise<ScreenRouteOutcome> {
    const generation = this.generation;
    const live = (): boolean => generation === this.generation && allowed();
    return this.enqueue(async () => {
      const backend = this.active;
      if (!backend || !live()) return 'rejected';
      const held = this.held[backend];
      for (const command of commands) {
        if (!live()) return 'rejected';
        if (command.op === 'text') {
          if (!(await this.sendText(backend, command, live))) return 'rejected';
          continue;
        }
        const hold = holdKeyOf(command);
        const down = isHoldDown(command);
        const here = this.backends[backend].identity();
        const key = hold && here ? heldKey(here, hold) : null;
        if (hold && !down && (!key || !held.has(key))) continue;
        if (hold && down) {
          // A press is only made where its landing place is known, so its
          // release can be routed back to exactly that desktop.
          if (!key || !here) return 'rejected';
          // Held before it is sent: a down whose delivery is uncertain is
          // still released.
          held.set(key, { release: releaseCommandFor(command), origin: here });
        }
        try {
          await this.send(backend, command);
        } catch {
          return 'rejected';
        }
        if (key && !down) held.delete(key);
      }
      return 'applied';
    });
  }

  /** Releases every press on every backend (see `release`). Runs after any
   *  in-flight command, is never cancelled, and is idempotent. */
  releaseAll(): Promise<void> {
    return this.enqueue(async () => {
      for (const id of BACKENDS) await this.release(id);
    });
  }

  /**
   * Makes `next` the active backend (null: none can inject). Before the
   * switch, the previous backend's presses are released through it (see
   * `release`).
   */
  switchTo(next: ScreenInputBackendId | null, hooks: ScreenSwitchHooks = {}): Promise<void> {
    return this.enqueue(async () => {
      const { before, after } = hooks;
      if (this.active && this.active !== next) await this.release(this.active);
      if (before) await this.guard(before).catch(() => {});
      this.active = next;
      if (after) await this.guard(after).catch(() => {});
    });
  }

  /** Resolves once every queued step has run. */
  settled(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Sends the release of every press `backend` holds, through `backend`, and
   *  forgets them all. One it can't deliver now (the backend reports another
   *  desktop or none, or the send fails or is abandoned) is dropped and
   *  counted: nothing is carried to a later point. */
  private async release(backend: ScreenInputBackendId): Promise<void> {
    const presses = [...this.held[backend].values()];
    this.held[backend].clear();
    let dropped = 0;
    for (const press of presses) {
      const delivered =
        sameDesktopIdentity(press.origin, this.backends[backend].identity()) &&
        (await this.send(backend, press.release).then(
          () => true,
          () => false
        ));
      if (!delivered) dropped += 1;
    }
    if (dropped > 0) this.onDropped(backend, dropped);
  }

  /** One backend send, cut off by `abandon()`. */
  private send(backend: ScreenInputBackendId, command: ScreenHostCommand): Promise<void> {
    return this.guard(() => this.backends[backend].send(command));
  }

  /** Runs a backend call that `abandon()` cuts off (it rejects at once). */
  private guard(call: () => Promise<void>): Promise<void> {
    if (this.abandoned) return Promise.reject(new Error('input_abandoned'));
    return new Promise<void>((resolve, reject) => {
      const fail = (): void => reject(new Error('input_abandoned'));
      this.abandonWaiters.add(fail);
      call()
        .then(resolve, reject)
        .finally(() => this.abandonWaiters.delete(fail));
    });
  }

  private textModifiers(backend: ScreenInputBackendId): TextModifiers {
    const here = this.backends[backend].identity();
    const held = [...this.held[backend]].filter(
      ([, entry]) => entry.release.op === 'key' && SHORTCUT_MODIFIER_VKS.has(entry.release.vk)
    );
    if (held.length === 0) return { mode: 'plain' };
    const vkOf = (entry: HeldPress): number => (entry.release.op === 'key' ? entry.release.vk : -1);
    const altGr =
      held.some(([, entry]) => vkOf(entry) === ALTGR_RIGHT_ALT) &&
      held.every(([, entry]) => ALTGR_VKS.has(vkOf(entry)) && sameDesktopIdentity(entry.origin, here));
    return altGr ? { mode: 'altgr', lifts: held.map(([id]) => id) } : { mode: 'refused' };
  }

  /**
   * Types literal text. Under a held shortcut modifier it is refused (never
   * queued or retried) so it cannot fire a shortcut. Under AltGr alone the
   * session's own AltGr keys are lifted, the text is typed as Unicode, and
   * the keys are pressed again, so the phone's held state is unchanged and the
   * target sees plain characters.
   *
   * `live` (generation + authorization) is checked before the text and before
   * each re-press. Once it fails nothing positive is sent: the text is
   * skipped, no modifier is pressed again, and the modifiers already lifted
   * are no longer held (they are up). Only modifiers not yet lifted stay
   * held, for the release that follows the cancel.
   *
   * The AltGr keys' origin is rechecked against the backend's identity before
   * every lift, before the text and before every re-press. Once it no longer
   * matches, nothing more is sent to this backend from here: no further
   * lift, no text, no re-press. The keys already lifted are up; the ones not
   * yet lifted can't be released on their desktop now, so they are dropped
   * and counted (the session-local release contract).
   */
  private async sendText(
    backend: ScreenInputBackendId,
    command: ScreenHostCommand,
    live: () => boolean
  ): Promise<boolean> {
    const modifiers = this.textModifiers(backend);
    if (modifiers.mode === 'refused') return false;
    if (modifiers.mode === 'plain') {
      if (!live()) return false;
      try {
        await this.send(backend, command);
        return true;
      } catch {
        return false;
      }
    }
    const held = this.held[backend];
    // `textModifiers` only chose AltGr with every key on the current identity.
    const origin = this.backends[backend].identity();
    let moved = false;
    const onOrigin = (): boolean => {
      if (!moved && !sameDesktopIdentity(origin, this.backends[backend].identity())) moved = true;
      return !moved;
    };
    const lifted: string[] = [];
    let liftsDone = true;
    for (const id of modifiers.lifts) {
      const entry = held.get(id);
      if (!entry) continue;
      if (!onOrigin()) {
        liftsDone = false;
        break;
      }
      try {
        await this.send(backend, entry.release);
        lifted.push(id);
      } catch {
        // Its state is uncertain: it stays held, so a release still follows.
        liftsDone = false;
        break;
      }
    }
    let typed = false;
    if (liftsDone && live() && onOrigin()) {
      try {
        await this.send(backend, command);
        typed = true;
      } catch {
        /* restored below; the input is reported not applied */
      }
    }
    for (const id of lifted) {
      const entry = held.get(id);
      if (!entry || entry.release.op !== 'key') continue;
      if (!live() || !onOrigin()) {
        // Cancelled (or moved desktop): the key is up; never pressed again.
        held.delete(id);
        continue;
      }
      // Still held while it is re-pressed: a cancel landing now is followed
      // by a release of it.
      await this.send(backend, { ...entry.release, down: true }).catch(() => {});
    }
    if (moved) {
      // Not yet lifted, and their desktop is no longer reachable here.
      const unreleasable = modifiers.lifts.filter((id) => !lifted.includes(id) && held.delete(id)).length;
      if (unreleasable > 0) this.onDropped(backend, unreleasable);
    }
    return typed;
  }
}
