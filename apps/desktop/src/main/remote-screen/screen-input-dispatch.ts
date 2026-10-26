/**
 * Maps a viewer's `RemoteScreenInput` to desktop host commands: pointer and
 * wheel points go through the display's geometry mapping, keys and text pass
 * straight to the injector. This layer is pure — it holds no state and tracks
 * no presses. Which backend each command reaches, and the guaranteed release
 * of every held key/button, belong to the router (screen-input-router.ts),
 * which owns presses per desktop so a release is never sent to the wrong one.
 */
import type { RemoteScreenButton, RemoteScreenInput } from '../../shared/remote-webrtc';
import { mapScreenPointer, type ScreenPointerMapping } from './screen-geometry';
import type { ScreenHostButton, ScreenHostCommand } from './screen-input-host';

const BUTTON_NAMES: Record<RemoteScreenButton, ScreenHostButton> = { left: 'left', right: 'right', middle: 'middle' };

/**
 * The commands one input produces, or `null` when it cannot be applied now:
 * a pointer/wheel whose `geometryGeneration` does not match the live mapping,
 * an out-of-bounds point, or a zero-delta wheel (the phone retries after the
 * next geometry-ack). `screen-release` is the router's concern and yields `[]`.
 */
export function screenInputCommands(
  input: RemoteScreenInput,
  mapping: ScreenPointerMapping | null,
  geometryGeneration: number
): ScreenHostCommand[] | null {
  switch (input.type) {
    case 'screen-pointer': {
      const at = point(mapping, input.x, input.y, geometryGeneration);
      // A button up must always be deliverable, or a press made before a
      // geometry change could never be lifted: unmapped, it releases in place.
      if (!at && input.action === 'up') return [{ op: 'button', button: BUTTON_NAMES[input.button], down: false }];
      if (!at) return null;
      if (input.action === 'move') return [{ op: 'move', x: at.x, y: at.y }];
      return [{ op: 'button', button: BUTTON_NAMES[input.button], down: input.action === 'down', at }];
    }
    case 'screen-wheel': {
      const at = point(mapping, input.x, input.y, geometryGeneration);
      if (!at || (input.deltaX === 0 && input.deltaY === 0)) return null;
      return [{ op: 'wheel', x: at.x, y: at.y, dx: input.deltaX, dy: input.deltaY }];
    }
    case 'screen-key':
      return [{ op: 'key', vk: input.vk, scan: input.scan, extended: input.extended, down: input.action === 'down' }];
    case 'screen-text':
      return [{ op: 'text', text: input.text }];
    case 'screen-release':
      return [];
  }
}

function point(
  mapping: ScreenPointerMapping | null,
  x: number,
  y: number,
  generation: number
): { x: number; y: number } | null {
  if (!mapping || mapping.generation !== generation) return null;
  return mapScreenPointer(mapping, x, y);
}

/** The press a down command establishes (so a repeat down is idempotent and an
 *  up finds the same key); `null` for a command that holds nothing. */
export function holdKeyOf(command: ScreenHostCommand): string | null {
  if (command.op === 'button') return `btn:${command.button}`;
  if (command.op === 'key') return `key:${command.vk}:${command.scan}:${command.extended ? 1 : 0}`;
  return null;
}

/** Whether a holding command presses (`true`) or releases (`false`). */
export function isHoldDown(command: ScreenHostCommand): boolean {
  return (command.op === 'button' || command.op === 'key') && command.down;
}

/** The up command that releases a down command. */
export function releaseCommandFor(command: ScreenHostCommand): ScreenHostCommand {
  if (command.op === 'button') return { op: 'button', button: command.button, down: false };
  if (command.op === 'key') {
    return { op: 'key', vk: command.vk, scan: command.scan, extended: command.extended, down: false };
  }
  throw new TypeError('screen release command is only defined for a held button or key');
}
