/**
 * Action classification for the Computer Use host: which commands read, which
 * mutate, which need a fresh observation, and which lanes they run on.
 */
import type { ComputerCommand } from '../shared/types';
import { computerActionsWith, computerActionHas } from '../../../../../../src/runtime/computer-bridge/actions.mjs';

/** The session the bridge warms up under, before any caller exists. */
export const HOST_WARMUP_SESSION_ID = '__computer_host_warmup__';

export const OBSERVATION_BOUND_INPUT_ACTIONS = new Set(computerActionsWith('observationBound'));
export const FOCUS_CONTINUATION_ACTIONS = new Set(computerActionsWith('focusContinuation'));
export const AUTO_CAPTURE_ACTIONS = new Set(computerActionsWith('autoCapture'));
export const READ_ACTIONS = new Set(computerActionsWith('hostRead'));

// Observation-only mode keeps every state read available and refuses anything
// that could change the desktop, before the command reaches a dispatch path.
export const OBSERVE_ONLY_ALLOWED_ACTIONS = new Set(computerActionsWith('observeOnly'));

export function isComputerLifecycleControl(command: ComputerCommand): boolean {
  return computerActionHas(String(command.action || ''), 'lifecycle');
}

export function requiresForegroundLane(command: ComputerCommand): boolean {
  const action = String(command.action || '');
  return command.delivery === 'foreground' || computerActionHas(action, 'foreground')
    || computerActionHas(action, 'focusGuard')
    || (action === 'sequence' && Array.isArray(command.steps)
      && command.steps.some(step => computerActionHas(String(step.action || ''), 'focusGuard')));
}

/** Resource serialization does not change the chosen input delivery. */
export function computerDeliveryMode(command: ComputerCommand): 'background' | 'foreground' {
  return command.delivery === 'foreground'
    || (command.delivery !== 'background' && computerActionHas(String(command.action || ''), 'foreground'))
    ? 'foreground' : 'background';
}
