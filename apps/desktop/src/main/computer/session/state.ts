/**
 * What a session accumulates while it observes: capture frames, element alias
 * targets, the observed window scope, and the last capture used as a change
 * baseline. The helpers here are the only writers, and a mutation invalidates
 * exactly the parts bound to a stale observation.
 */
import type {
  CaptureFrame,
  ComputerCommand,
  ComputerElementRecord,
  ComputerInputObservation,
  ElementAliasTarget,
  ObservedWindowScope,
} from '../shared/types';
import { elementTarget, resolveElementAliases, visualPointForRef } from './element-aliases';
import { elementTargetsFromRecords, normalizeElementRecords } from './element-records';
import { assertFrameSurfaceUnchanged } from './frame-validity';
import {
  invalidateComputerActionTargets,
  invalidateComputerWorkerGeneration,
  isFreshComputerObservation,
  rememberLatestComputerFrame,
  releaseComputerSessionResources,
  resolveFreshComputerObservationScope,
} from './resources';

export interface SessionStateHost {
  callPowerShell(request: Record<string, unknown>): Promise<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }>;
}

/** Last semantic capture per session. It outlives the ref/frame invalidation a
 *  mutation triggers, so the fresh capture that follows can report what
 *  changed instead of making the model re-read the whole tree. */
interface LastCapture {
  windowId: string;
  baselineKey: string;
  elements: Map<string, string>;
  refIdentities: Map<string, string>;
}

export function createSessionState(host: SessionStateHost) {
  const framesBySession = new Map<string, Map<string, CaptureFrame>>();
  const elementTargetsBySession = new Map<string, Map<number, ElementAliasTarget>>();
  const observedWindowBySession = new Map<string, ObservedWindowScope>();
  const lastCaptureBySession = new Map<string, LastCapture>();

  /** Frame ids are per host, so a stale id from another session is refused
   *  by lookup rather than by chance. */
  let nextFrameId = 1;
  function allocateFrameId(): number {
    return nextFrameId++;
  }

  function sessionIdFor(command: ComputerCommand): string {
    return String(command.session_id || 'default');
  }

  function rememberFrame(frame: CaptureFrame): void {
    rememberLatestComputerFrame(frame.sessionId, frame.id, frame, framesBySession);
  }

  function rememberObservedWindowScope(
    command: ComputerCommand,
    primaryWindowId: string,
    relatedWindowIds: string[] = [],
    inputObservation?: ComputerInputObservation
  ): void {
    if (!primaryWindowId) return;
    observedWindowBySession.set(sessionIdFor(command), {
      primaryWindowId,
      relatedWindowIds: [...new Set([primaryWindowId, ...relatedWindowIds.map(String).filter(Boolean)])],
      observedAt: performance.now(),
      ...(inputObservation ? { inputObservation } : {}),
    });
  }

  function freshObservedWindowScope(command: ComputerCommand): ObservedWindowScope | undefined {
    const sessionId = sessionIdFor(command);
    const { scope, expired } = resolveFreshComputerObservationScope(
      sessionId,
      observedWindowBySession,
      performance.now()
    );
    if (expired) {
      invalidateActionTargets(command);
    }
    return scope;
  }

  function forgetObservedWindowScope(command: ComputerCommand): void {
    observedWindowBySession.delete(sessionIdFor(command));
  }

  /** Every other session observing one of these windows loses its refs and
   *  frames: the mutation changed what they saw. */
  function invalidateWindowTargets(windowIds: Array<string | undefined>, exceptSessionId: string): void {
    const ids = new Set(windowIds.filter(Boolean).map((id) => String(id).toLowerCase()));
    const sessions = new Set([...observedWindowBySession.keys(), ...framesBySession.keys()]);
    for (const sessionId of sessions) {
      if (sessionId === exceptSessionId) continue;
      const scope = observedWindowBySession.get(sessionId);
      const frames = framesBySession.get(sessionId);
      const related = [
        ...(scope?.relatedWindowIds || []),
        ...[...(frames?.values() || [])].flatMap((frame) => [...(frame.relatedWindowIds || []), frame.windowId || '']),
      ];
      if (!related.some((id) => ids.has(id.toLowerCase()))) continue;
      invalidateComputerActionTargets(sessionId, { framesBySession, elementTargetsBySession });
      observedWindowBySession.delete(sessionId);
    }
  }

  function invalidateActionTargets(command: ComputerCommand): void {
    invalidateComputerActionTargets(sessionIdFor(command), {
      framesBySession,
      elementTargetsBySession,
    });
  }

  function releaseSessionState(sessionId: string, releaseCaptureSession?: (releasedSessionId: string) => void): void {
    releaseComputerSessionResources(
      sessionId,
      {
        framesBySession,
        elementTargetsBySession,
        observedWindowBySession,
        lastCaptureBySession,
      },
      releaseCaptureSession
    );
  }

  function invalidateWorkerGeneration(sessionId: string): void {
    invalidateComputerWorkerGeneration(sessionId, {
      framesBySession,
      elementTargetsBySession,
      observedWindowBySession,
      lastCaptureBySession,
    });
  }

  function rememberElementTargets(command: ComputerCommand, elements: ComputerElementRecord[]): void {
    elementTargetsBySession.set(sessionIdFor(command), elementTargetsFromRecords(elements));
  }

  const elementTargets = (command: ComputerCommand) => elementTargetsBySession.get(sessionIdFor(command));

  /** The frame a pixel command names, still fresh and still where it was. */
  async function requireValidFrame(command: ComputerCommand): Promise<CaptureFrame> {
    const frameId = String(command.frame_id || '');
    if (!frameId) throw new Error('frame_id is required for pixel coordinates');
    const frame = framesBySession.get(sessionIdFor(command))?.get(frameId);
    if (!frame) throw new Error(`stale_frame: unknown frame_id ${frameId} in this session`);
    if (!isFreshComputerObservation(frame.capturedAt, performance.now())) {
      invalidateActionTargets(command);
      throw new Error(`stale_frame: frame expired (${frame.id}); capture the target again`);
    }
    await assertFrameSurfaceUnchanged(host, frame);
    return frame;
  }

  return {
    framesBySession,
    elementTargetsBySession,
    observedWindowBySession,
    lastCaptureBySession,
    allocateFrameId,
    sessionIdFor,
    rememberFrame,
    rememberObservedWindowScope,
    freshObservedWindowScope,
    forgetObservedWindowScope,
    invalidateActionTargets,
    invalidateWindowTargets,
    invalidateWorkerGeneration,
    releaseSessionState,
    normalizeElementRecords,
    rememberElementTargets,
    elementTarget: (command: ComputerCommand, mark: number | undefined, label: string) =>
      elementTarget(elementTargets(command), mark, label),
    resolveElementAliases: (command: ComputerCommand) => resolveElementAliases(command, elementTargets(command)),
    visualPointForRef: (command: ComputerCommand, ref: string | undefined) =>
      visualPointForRef(elementTargets(command), ref),
    requireValidFrame,
  };
}
