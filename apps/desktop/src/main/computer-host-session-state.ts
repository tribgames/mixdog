/**
 * What a session accumulates while it observes: capture frames, element alias
 * targets, the observed window scope, and the last capture used as a change
 * baseline. The helpers here are the only writers, and a mutation invalidates
 * exactly the parts bound to a stale observation.
 */
import { screen } from 'electron';

import type { ChromeUiaAncestor } from './browser-chrome-uia';

/** Actions that may address an element by alias, and the subset that can fall
 *  back to pixels when the alias resolves to a point. */
const ELEMENT_ALIAS_ACTIONS = new Set([
  'invoke', 'set_value', 'toggle',
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'mouse_move', 'drag', 'type', 'key', 'scroll',
]);
const PIXEL_ALIAS_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'mouse_move', 'drag', 'scroll', 'type',
]);

import type {
  CaptureFrame,
  ComputerCommand,
  ComputerElementRecord,
  ElementAliasTarget,
  ObservedWindowScope,
} from './computer-host-types';

export interface SessionStateHost {
  callPowerShell(request: Record<string, unknown>): Promise<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }>;
}

export function createSessionState(host: SessionStateHost) {
  const { callPowerShell } = host;

  const framesBySession = new Map<string, Map<string, CaptureFrame>>();
  const elementTargetsBySession = new Map<string, Map<number, ElementAliasTarget>>();
  const observedWindowBySession = new Map<string, ObservedWindowScope>();
  // Last semantic capture per session. It outlives the ref/frame invalidation a
  // mutation triggers, so the fresh capture that follows can report what
  // changed instead of making the model re-read the whole tree.
  const lastCaptureBySession = new Map<string, {
    windowId: string;
    baselineKey: string;
    elements: Map<string, string>;
    refIdentities: Map<string, string>;
  }>();

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
    let frames = framesBySession.get(frame.sessionId);
    if (!frames) {
      frames = new Map();
      framesBySession.set(frame.sessionId, frames);
    }
    frames.set(frame.id, frame);
    while (frames.size > 8) frames.delete(frames.keys().next().value as string);
  }

  function rememberObservedWindowScope(
    command: ComputerCommand,
    primaryWindowId: string,
    relatedWindowIds: string[] = [],
  ): void {
    if (!primaryWindowId) return;
    observedWindowBySession.set(sessionIdFor(command), {
      primaryWindowId,
      relatedWindowIds: [...new Set([
        primaryWindowId,
        ...relatedWindowIds.map(String).filter(Boolean),
      ])],
    });
  }

  function forgetObservedWindowScope(command: ComputerCommand): void {
    observedWindowBySession.delete(sessionIdFor(command));
  }

  function normalizeElementRecords(value: unknown): ComputerElementRecord[] {
    if (!Array.isArray(value)) return [];
    const elements: ComputerElementRecord[] = [];
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const mark = Number(row.mark);
      const ref = String(row.ref || '');
      if (!Number.isInteger(mark) || mark < 1 || !ref) continue;
      const ancestors: ChromeUiaAncestor[] = Array.isArray(row.ancestors)
        ? row.ancestors.flatMap((rawAncestor) => {
            if (!rawAncestor || typeof rawAncestor !== 'object') return [];
            const ancestor = rawAncestor as Record<string, unknown>;
            return [{
              runtime_id: String(ancestor.runtime_id || ''),
              role: String(ancestor.role || ''),
              name: String(ancestor.name || ''),
            }];
          })
        : [];
      elements.push({
        mark,
        ref,
        source: row.source === 'msaa' ? 'msaa' : 'uia',
        role: String(row.role || ''),
        name: String(row.name || ''),
        value: String(row.value || ''),
        state: String(row.state || ''),
        enabled: row.enabled === true,
        x: Number(row.x) || 0,
        y: Number(row.y) || 0,
        width: Number(row.width) || 0,
        height: Number(row.height) || 0,
        center_x: Number(row.center_x) || 0,
        center_y: Number(row.center_y) || 0,
        actions: Array.isArray(row.actions)
          ? row.actions.map((action) => String(action)).filter(Boolean)
          : [],
        runtime_id: String(row.runtime_id || '') || undefined,
        parent_runtime_id: String(row.parent_runtime_id || '') || undefined,
        class_name: String(row.class_name || '') || undefined,
        has_keyboard_focus: row.has_keyboard_focus === true,
        in_document: row.in_document === true,
        ancestors,
      });
    }
    return elements;
  }

  function rememberElementTargets(command: ComputerCommand, elements: ComputerElementRecord[]): void {
    const targets = new Map<number, ElementAliasTarget>();
    for (const element of elements) {
      if (element.source === 'ocr') {
        if (!element.frame_id) continue;
        targets.set(element.mark, {
          kind: 'point',
          frameId: element.frame_id,
          windowId: element.window_id,
          x: element.center_x,
          y: element.center_y,
        });
      } else {
        targets.set(element.mark, { kind: 'ref', ref: element.ref });
      }
    }
    elementTargetsBySession.set(sessionIdFor(command), targets);
  }

  function elementTarget(
    command: ComputerCommand,
    mark: number | undefined,
    label: string,
  ): ElementAliasTarget | undefined {
    if (mark === undefined) return undefined;
    if (!Number.isInteger(mark) || mark < 1) throw new Error(`${label} must be a positive integer from the latest capture`);
    const target = elementTargetsBySession.get(sessionIdFor(command))?.get(mark);
    if (!target) throw new Error(`stale_element: ${label}=${mark} is not in the latest capture for this session`);
    return target;
  }

  function resolveElementAliases(command: ComputerCommand): ComputerCommand {
    const markedTarget = ELEMENT_ALIAS_ACTIONS.has(command.action)
      ? elementTarget(command, command.element, 'element')
      : undefined;
    const markedDestination = command.action === 'drag'
      ? elementTarget(command, command.to_element, 'to_element')
      : undefined;
    for (const [target, label] of [
      [markedTarget, 'element'],
      [markedDestination, 'to_element'],
    ] as const) {
      if (target?.kind === 'point' && target.windowId && command.window_id
        && target.windowId !== command.window_id) {
        throw new Error(`${label} and window_id identify different windows`);
      }
    }
    if (markedTarget?.kind === 'point' && !PIXEL_ALIAS_ACTIONS.has(command.action)) {
      throw new Error(`OCR element marks do not support '${command.action}'; use a semantic ref or click the OCR mark first`);
    }
    if (markedTarget?.kind === 'ref' && markedTarget.ref && command.ref
      && markedTarget.ref !== command.ref) {
      throw new Error('element and ref identify different controls');
    }
    if (markedDestination?.kind === 'ref' && markedDestination.ref && command.to
      && markedDestination.ref !== command.to) {
      throw new Error('to_element and to identify different controls');
    }
    if (markedTarget && markedDestination && markedTarget.kind !== markedDestination.kind) {
      throw new Error('drag source and destination must both be semantic elements or both be OCR/frame points');
    }
    if (markedTarget?.kind === 'point' && markedDestination?.kind === 'point'
      && (markedTarget.frameId !== markedDestination.frameId
        || markedTarget.windowId !== markedDestination.windowId)) {
      throw new Error('drag source and destination must come from the same fresh frame and window');
    }
    return {
      ...command,
      ...(markedTarget?.kind === 'ref' && markedTarget.ref ? { ref: markedTarget.ref } : {}),
      ...(markedTarget?.kind === 'point' ? {
        ref: undefined,
        frame_id: markedTarget.frameId,
        window_id: markedTarget.windowId || command.window_id,
        x: markedTarget.x,
        y: markedTarget.y,
      } : {}),
      ...(markedDestination?.kind === 'ref' && markedDestination.ref
        ? { to: markedDestination.ref }
        : {}),
      ...(markedDestination?.kind === 'point' ? {
        to: undefined,
        frame_id: markedDestination.frameId,
        window_id: markedDestination.windowId || command.window_id,
        to_x: markedDestination.x,
        to_y: markedDestination.y,
      } : {}),
    };
  }

  async function requireValidFrame(command: ComputerCommand): Promise<CaptureFrame> {
    const frameId = String(command.frame_id || '');
    if (!frameId) throw new Error('frame_id is required for pixel coordinates');
    const frame = framesBySession.get(sessionIdFor(command))?.get(frameId);
    if (!frame) throw new Error(`stale_frame: unknown frame_id ${frameId} in this session`);
    if (frame.kind === 'window') {
      const bounds = await callPowerShell({
        action: 'window_bounds',
        window_id: frame.windowId,
        session_id: frame.sessionId,
        read_only: true,
      });
      if (!bounds.ok) throw new Error(`stale_frame: target window is gone (${frame.windowId})`);
      const same = Number(bounds.result?.x) === (frame.targetWindowX ?? frame.windowX)
        && Number(bounds.result?.y) === (frame.targetWindowY ?? frame.windowY)
        && Number(bounds.result?.width) === (frame.targetWindowWidth ?? frame.windowWidth)
        && Number(bounds.result?.height) === (frame.targetWindowHeight ?? frame.windowHeight);
      if (!same) throw new Error(`stale_frame: target window moved or resized (${frame.id})`);
    } else {
      const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === frame.displayId);
      const origin = display?.nativeOrigin ?? (display ? { x: display.bounds.x, y: display.bounds.y } : null);
      const same = !!display && !!origin
        && origin.x === frame.displayX
        && origin.y === frame.displayY
        && Math.round(display.size.width * display.scaleFactor) === frame.displayWidth
        && Math.round(display.size.height * display.scaleFactor) === frame.displayHeight;
      if (!same) throw new Error(`stale_frame: display layout changed (${frame.id})`);
    }
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
    forgetObservedWindowScope,
    normalizeElementRecords,
    rememberElementTargets,
    elementTarget,
    resolveElementAliases,
    requireValidFrame,
  };
}
