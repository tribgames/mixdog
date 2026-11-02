/**
 * Action classification for the Computer Use host: which commands read, which
 * mutate, which need a fresh observation, and which lanes they run on.
 */
import type { ComputerCommand } from '../shared/types';
import { computerActionsWith, computerActionHas } from '../../../../../../src/runtime/computer-bridge/actions.mjs';

/** The session the bridge warms up under, before any caller exists. */
export const HOST_WARMUP_SESSION_ID = '__computer_host_warmup__';

export const OBSERVATION_BOUND_INPUT_ACTIONS = new Set(computerActionsWith('observationBound'));
export const AUTO_CAPTURE_ACTIONS = new Set(computerActionsWith('autoCapture'));
export const READ_ACTIONS = new Set(computerActionsWith('hostRead'));

// Observation-only mode keeps every state read available and refuses anything
// that could change the desktop, before the command reaches a dispatch path.
export const OBSERVE_ONLY_ALLOWED_ACTIONS = new Set(computerActionsWith('observeOnly'));

/** Pointer actions that land on frame-bound x/y when no ref is given. */
export const PIXEL_INPUT_ACTIONS = new Set([
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'triple_click',
  'mouse_down',
  'mouse_up',
  'mouse_move',
]);

export function isComputerLifecycleControl(command: ComputerCommand): boolean {
  return computerActionHas(String(command.action || ''), 'lifecycle');
}

function focusGuarded(command: ComputerCommand): boolean {
  const guardsFocus = (step: Partial<ComputerCommand>) =>
    computerActionHas(String(step.action || ''), 'focusGuard') ||
    (step.action === 'click' && Boolean(step.ref) && !step.modifiers);
  return (
    guardsFocus(command) ||
    (command.action === 'sequence' && Array.isArray(command.steps) && command.steps.some(guardsFocus))
  );
}

export function requiresForegroundLane(command: ComputerCommand): boolean {
  return (
    command.delivery === 'foreground' ||
    computerActionHas(String(command.action || ''), 'foreground') ||
    focusGuarded(command)
  );
}

/** A background semantic action on the lane only to keep its focus guard apart
 *  from foreground input. It targets its own window by ref, so waiting for the
 *  lane does not by itself make its observation stale. */
export function guardsBackgroundFocus(command: ComputerCommand): boolean {
  return command.delivery !== 'foreground' && focusGuarded(command);
}

/** Resource serialization does not change the chosen input delivery. */
export function computerDeliveryMode(command: ComputerCommand): 'background' | 'foreground' {
  return command.delivery === 'foreground' ||
    (command.delivery !== 'background' && computerActionHas(String(command.action || ''), 'foreground'))
    ? 'foreground'
    : 'background';
}
