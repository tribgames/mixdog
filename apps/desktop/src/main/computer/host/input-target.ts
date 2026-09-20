/**
 * Where an input lands and whether it may be sent there: frame-bound
 * coordinates become physical screen ones through the frame they name, the
 * frame's window becomes the target, and an observation-bound action must
 * still target the window scope this session last observed.
 */
import { framePoint } from '../observation/analysis';
import type { CaptureFrame, ComputerCommand } from '../shared/types';
import { OBSERVATION_BOUND_INPUT_ACTIONS, PIXEL_INPUT_ACTIONS } from './action-sets';
import type { InputResolutionHost, ResolvedInputTarget } from './input-resolution';

export type InputTargetHost = Pick<InputResolutionHost, 'requireValidFrame' | 'freshObservedWindowScope'>;

/** The frame's window becomes the target and its related windows the allowed
 *  set; `requiresWindow` names the gesture that cannot proceed without one. */
function bindFrameWindow(target: ResolvedInputTarget, frame: CaptureFrame, requiresWindow?: string): void {
  target.targetWindowId = frame.windowId || target.targetWindowId;
  if (requiresWindow && !target.targetWindowId) {
    throw new Error(`${requiresWindow} requires a window capture frame`);
  }
  target.allowedWindowIds = frame.relatedWindowIds || (target.targetWindowId ? [target.targetWindowId] : []);
}

async function applyFrameBoundPoint(
  host: InputTargetHost,
  command: ComputerCommand,
  target: ResolvedInputTarget,
  missingCoordinates: string,
  requiresWindow?: string
): Promise<void> {
  if (command.x === undefined || command.y === undefined) throw new Error(missingCoordinates);
  const frame = await host.requireValidFrame(command);
  const point = framePoint(frame, command.x, command.y);
  target.physicalX = point.x;
  target.physicalY = point.y;
  bindFrameWindow(target, frame, requiresWindow);
}

async function applyFrameBoundDrag(host: InputTargetHost, command: ComputerCommand, target: ResolvedInputTarget) {
  if (command.x === undefined || command.y === undefined || command.to_x === undefined || command.to_y === undefined) {
    throw new Error('drag requires ref/to or frame-bound x/y/to_x/to_y coordinates');
  }
  const frame = await host.requireValidFrame(command);
  const from = framePoint(frame, command.x, command.y);
  const to = framePoint(frame, command.to_x, command.to_y);
  target.physicalX = from.x;
  target.physicalY = from.y;
  target.physicalToX = to.x;
  target.physicalToY = to.y;
  bindFrameWindow(target, frame, 'coordinate drag');
}

/** Every waypoint belongs to the same frame, so one frame lookup maps the
 *  whole gesture and keeps the points from drifting across windows. */
async function applyWaypointDrag(
  host: InputTargetHost,
  command: ComputerCommand,
  waypoints: NonNullable<ComputerCommand['waypoints']>,
  target: ResolvedInputTarget
) {
  const frame = await host.requireValidFrame(command);
  target.physicalPath = waypoints.map((point) => framePoint(frame, point.x, point.y));
  bindFrameWindow(target, frame, 'waypoint drag');
}

function bindObservedScope(
  host: InputTargetHost,
  command: ComputerCommand,
  action: string,
  target: ResolvedInputTarget,
  trustedSequenceContinuation: boolean
): void {
  const observedScope = host.freshObservedWindowScope(command);
  if (!observedScope && !(trustedSequenceContinuation && target.targetWindowId)) {
    throw new Error(`${action} requires a fresh capture/snapshot/find of the exact target window first`);
  }
  if (observedScope && target.targetWindowId && !observedScope.relatedWindowIds.includes(target.targetWindowId)) {
    throw new Error(
      `stale_target: ${action} targets ${target.targetWindowId}, but the latest observation is ` +
        observedScope.primaryWindowId
    );
  }
  target.observedScope = observedScope;
  target.targetWindowId = target.targetWindowId || observedScope?.primaryWindowId;
}

export async function resolveInputTarget(
  host: InputTargetHost,
  command: ComputerCommand,
  action: string,
  trustedSequenceContinuation: boolean
): Promise<ResolvedInputTarget> {
  const target: ResolvedInputTarget = {
    physicalX: command.x,
    physicalY: command.y,
    physicalToX: command.to_x,
    physicalToY: command.to_y,
    physicalPath: undefined,
    targetWindowId: command.window_id,
    allowedWindowIds: [],
    observedScope: undefined,
  };
  const pointsAtPixels =
    PIXEL_INPUT_ACTIONS.has(action) || (action === 'type' && command.x !== undefined && command.y !== undefined);
  if (pointsAtPixels && !command.ref) {
    await applyFrameBoundPoint(host, command, target, `${action} requires ref or frame-bound x/y coordinates`);
  }
  if (action === 'drag' && !command.ref && !Array.isArray(command.waypoints)) {
    await applyFrameBoundDrag(host, command, target);
  }
  if (action === 'drag' && Array.isArray(command.waypoints)) {
    await applyWaypointDrag(host, command, command.waypoints, target);
  }
  if (action === 'scroll' && !command.ref && (command.x !== undefined || command.y !== undefined)) {
    await applyFrameBoundPoint(
      host,
      command,
      target,
      'coordinate scroll requires frame-bound x and y',
      'coordinate scroll'
    );
  }
  if (OBSERVATION_BOUND_INPUT_ACTIONS.has(action)) {
    bindObservedScope(host, command, action, target, trustedSequenceContinuation);
  }
  return target;
}
