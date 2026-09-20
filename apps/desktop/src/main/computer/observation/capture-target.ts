/**
 * Which window (or screen) a capture command is about: the shape rules a
 * command must satisfy and the lookups that turn window/app/foreground into an
 * exact window id.
 */
import { assertOcrLanguageTag, type captureMode } from './analysis';
import type { ComputerCommand } from '../shared/types';

export type CaptureMode = ReturnType<typeof captureMode>;

export interface CaptureTargetHost {
  callPowerShell(
    request: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
  sessionIdFor(command: ComputerCommand): string;
  resolveAppWindowId(command: ComputerCommand): Promise<string>;
  resolveForegroundWindowId(command: ComputerCommand): Promise<string>;
}

const namesOwnTarget = (command: ComputerCommand, forcedWindowId?: string) =>
  !forcedWindowId && !command.window_id && !command.window && !command.app;

export function assertCaptureTargetShape(
  command: ComputerCommand,
  forcedWindowId: string | undefined,
  mode: CaptureMode
) {
  if (mode === 'ax' && command.include_ocr) {
    throw new Error('include_ocr requires capture mode state, som, or vision');
  }
  assertOcrLanguageTag(command.ocr_language);
  if (forcedWindowId) return;
  const explicitTargets = [
    command.window_id?.trim(),
    command.window?.trim(),
    command.app?.trim(),
    command.screen !== undefined ? String(command.screen) : '',
  ].filter(Boolean);
  if (explicitTargets.length > 1) {
    throw new Error('capture accepts only one exact window, app, or screen target');
  }
}

/** A screen-only capture: vision mode aimed at a screen with no window named. */
export function explicitScreenCapture(command: ComputerCommand, forcedWindowId: string | undefined, mode: CaptureMode) {
  return mode === 'vision' && command.screen !== undefined && namesOwnTarget(command, forcedWindowId);
}

export function assertScreenTargetMode(
  command: ComputerCommand,
  forcedWindowId: string | undefined,
  mode: CaptureMode
) {
  if (mode !== 'vision' && command.screen !== undefined && namesOwnTarget(command, forcedWindowId)) {
    throw new Error('screen capture supports mode=vision only; use app or window_id for state/som/ax');
  }
}

export async function resolveCaptureWindowId(
  host: CaptureTargetHost,
  command: ComputerCommand,
  forcedWindowId: string | undefined,
  explicitScreen: boolean
): Promise<string> {
  let windowId = forcedWindowId || command.window_id || '';
  if (!windowId && command.window) {
    const bounds = await host.callPowerShell({
      action: 'window_bounds',
      window: command.window,
      session_id: host.sessionIdFor(command),
      read_only: true,
    });
    if (!bounds.ok) throw new Error(bounds.error || 'window lookup failed');
    windowId = String(bounds.result?.window_id || '');
  }
  if (!windowId && command.app) windowId = await host.resolveAppWindowId(command);
  if (!windowId && !explicitScreen) windowId = await host.resolveForegroundWindowId(command);
  return windowId;
}
