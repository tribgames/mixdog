/**
 * Element aliases: a command may name a control by the mark it carried in the
 * latest capture. The mark resolves against that capture's targets — a
 * semantic ref, or an OCR/frame point for pointer actions — and must agree
 * with any explicit ref, window or coordinates the command also names.
 */
import type { ComputerCommand, ElementAliasTarget } from '../shared/types';

/** Actions that may address an element by alias, and the subset that can fall
 *  back to pixels when the alias resolves to a point. */
const ELEMENT_ALIAS_ACTIONS = new Set([
  'invoke',
  'set_value',
  'toggle',
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'triple_click',
  'mouse_down',
  'mouse_up',
  'mouse_move',
  'drag',
  'type',
  'key',
  'key_down',
  'key_up',
  'scroll',
]);
const PIXEL_ALIAS_ACTIONS = new Set([
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'triple_click',
  'mouse_down',
  'mouse_up',
  'mouse_move',
  'drag',
  'scroll',
  'type',
]);

export type ElementTargets = Map<number, ElementAliasTarget> | undefined;

/** A capture publishes each OCR word as `ocr:<frame_id>:<mark>` in its ref, so
 *  a caller may name it there instead of in `element`. It resolves through the
 *  same targets as the mark, and only from the frame the capture recorded: a
 *  mark number alone would point at whatever the newest frame put there. */
const OCR_REF_PATTERN = /^ocr:(.+):(\d+)$/;

function ocrRefTarget(targets: ElementTargets, value: unknown, label: string): ElementAliasTarget | undefined {
  const match = OCR_REF_PATTERN.exec(String(value || ''));
  if (!match) return undefined;
  const target = elementTarget(targets, Number(match[2]), label);
  if (target?.kind !== 'point' || target.frameId !== match[1]) {
    throw new Error(`stale_element: ${label}=${String(value)} is not in the latest capture for this session`);
  }
  return target;
}

export function elementTarget(
  targets: ElementTargets,
  mark: number | undefined,
  label: string
): ElementAliasTarget | undefined {
  if (mark === undefined) return undefined;
  if (!Number.isInteger(mark) || mark < 1)
    throw new Error(`${label} must be a positive integer from the latest capture`);
  const target = targets?.get(mark);
  if (!target) throw new Error(`stale_element: ${label}=${mark} is not in the latest capture for this session`);
  return target;
}

// Marks and explicit refs/coordinates must name the same control and, for a
// drag, the same kind of source and destination.
function assertElementAliasTargets(
  command: ComputerCommand,
  markedTarget: ElementAliasTarget | undefined,
  markedDestination: ElementAliasTarget | undefined
): void {
  for (const [target, label] of [
    [markedTarget, 'element'],
    [markedDestination, 'to_element'],
  ] as const) {
    if (target?.kind === 'point' && target.windowId && command.window_id && target.windowId !== command.window_id) {
      throw new Error(`${label} and window_id identify different windows`);
    }
  }
  if (markedTarget?.kind === 'point' && !PIXEL_ALIAS_ACTIONS.has(command.action)) {
    throw new Error(
      `OCR element marks do not support '${command.action}'; use a semantic ref or click the OCR mark first`
    );
  }
  if (markedTarget?.kind === 'ref' && markedTarget.ref && command.ref && markedTarget.ref !== command.ref) {
    throw new Error('element and ref identify different controls');
  }
  if (
    markedDestination?.kind === 'ref' &&
    markedDestination.ref &&
    command.to &&
    markedDestination.ref !== command.to
  ) {
    throw new Error('to_element and to identify different controls');
  }
  if (markedTarget && markedDestination && markedTarget.kind !== markedDestination.kind) {
    throw new Error('drag source and destination must both be semantic elements or both be OCR/frame points');
  }
  if (
    markedTarget?.kind === 'point' &&
    markedDestination?.kind === 'point' &&
    (markedTarget.frameId !== markedDestination.frameId || markedTarget.windowId !== markedDestination.windowId)
  ) {
    throw new Error('drag source and destination must come from the same fresh frame and window');
  }
}

/** The command with its element / to_element marks replaced by what they
 *  name: a ref, or frame-bound coordinates for a point. */
export function resolveElementAliases(command: ComputerCommand, targets: ElementTargets): ComputerCommand {
  const markedTarget = ELEMENT_ALIAS_ACTIONS.has(command.action)
    ? (elementTarget(targets, command.element, 'element') ?? ocrRefTarget(targets, command.ref, 'ref'))
    : undefined;
  const markedDestination =
    command.action === 'drag'
      ? (elementTarget(targets, command.to_element, 'to_element') ?? ocrRefTarget(targets, command.to, 'to'))
      : undefined;
  assertElementAliasTargets(command, markedTarget, markedDestination);
  return {
    ...command,
    ...(markedTarget?.kind === 'ref' && markedTarget.ref ? { ref: markedTarget.ref } : {}),
    ...(markedTarget?.kind === 'point'
      ? {
          ref: undefined,
          frame_id: markedTarget.frameId,
          window_id: markedTarget.windowId || command.window_id,
          x: markedTarget.x,
          y: markedTarget.y,
        }
      : {}),
    ...(markedDestination?.kind === 'ref' && markedDestination.ref ? { to: markedDestination.ref } : {}),
    ...(markedDestination?.kind === 'point'
      ? {
          to: undefined,
          frame_id: markedDestination.frameId,
          window_id: markedDestination.windowId || command.window_id,
          to_x: markedDestination.x,
          to_y: markedDestination.y,
        }
      : {}),
  };
}

/** The center the latest capture recorded for a semantic ref, if it had one. */
export function visualPointForRef(
  targets: ElementTargets,
  ref: string | undefined
): { x: number; y: number } | undefined {
  if (!ref) return undefined;
  for (const target of targets?.values() || []) {
    if (target.kind !== 'ref' || target.ref !== ref || !Number.isFinite(target.x) || !Number.isFinite(target.y))
      continue;
    return { x: target.x as number, y: target.y as number };
  }
  return undefined;
}
