/**
 * The read-only questions Computer Use can answer: whether the backend, OCR and
 * accessibility are ready, and whether a bounded condition has become true. A
 * wait reads predicate state only, so it never invalidates the refs the caller
 * is holding and never returns pixels.
 */
import { elapsedMs } from '../shared/common';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import type { ComputerWindowRecord } from '../shared/window-transition';
import { assertOcrLanguageTag } from './analysis';
import { type ProbeReport, probeAccessibility, probeInputObservation, probeOcr } from './diagnose-probes';
import { verifyWindowState } from './verify-window';

export interface InspectHost {
  callPowerShell(
    request: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }>;
  sessionIdFor(command: ComputerCommand): string;
  assertExecutionNotAborted(): void;
  readComputerWindows(command: ComputerCommand, includeApp?: boolean): Promise<ComputerWindowRecord[] | null>;
  readDisplays(): Array<Record<string, unknown>>;
  isObserveOnly(): boolean;
  readInputState?(): { userControlActive: boolean; cleanupState?: string; takeoverReason?: string };
}

type InputState = ReturnType<NonNullable<InspectHost['readInputState']>>;

/** Everything a diagnose reply is written from. */
interface Diagnosis {
  command: ComputerCommand;
  startedAt: number;
  windows: ComputerWindowRecord[] | null;
  requestedWindowId: string;
  target: ComputerWindowRecord | undefined;
  accessibility: ProbeReport;
  ocr: ProbeReport;
  inputObservation: ProbeReport;
  displays: Array<Record<string, unknown>>;
  inputState: InputState | undefined;
  inputBlocked: boolean;
  observeOnly: boolean;
}

function diagnoseIssues(diagnosis: Diagnosis): string[] {
  const { command, windows, requestedWindowId, target, inputBlocked, inputState, inputObservation } = diagnosis;
  const issues: string[] = [];
  if (!windows) issues.push('window enumeration failed');
  if (requestedWindowId && !target) issues.push(`requested window is unavailable: ${requestedWindowId}`);
  if (inputBlocked) issues.push(`input blocked: ${inputState?.takeoverReason || inputState?.cleanupState}`);
  if (inputObservation.ready !== true) {
    issues.push(
      inputObservation.input_held === true
        ? 'foreground input is unavailable while physical input is held'
        : String(inputObservation.error || 'foreground input observation is unavailable')
    );
  }
  if (diagnosis.accessibility.available === false) {
    issues.push(String(diagnosis.accessibility.reason || 'accessibility unavailable'));
  }
  if (command.ocr_language && diagnosis.ocr.available !== true) {
    issues.push(`Windows OCR language is unavailable: ${command.ocr_language}`);
  }
  return issues;
}

function diagnoseReport(diagnosis: Diagnosis): ComputerCommandResult {
  const { windows, requestedWindowId, target, inputState, inputBlocked, inputObservation } = diagnosis;
  let inputMode = 'enabled';
  if (diagnosis.observeOnly) inputMode = 'observation_only';
  else if (inputBlocked) inputMode = 'blocked';
  return {
    text: JSON.stringify({
      ok: windows !== null,
      action: 'diagnose',
      platform: 'win32',
      ready:
        windows !== null && (!requestedWindowId || Boolean(target)) && !inputBlocked && inputObservation.ready === true,
      backend: 'win32_uia_powershell_electron',
      windows: {
        available: windows !== null,
        count: windows?.length || 0,
        focused_window_id: windows?.find((window) => window.focused)?.id || null,
      },
      capabilities: {
        exact_window_capture: true,
        semantic_accessibility: diagnosis.accessibility,
        ocr: diagnosis.ocr,
        delivery_modes: ['background', 'foreground'],
        input_mode: inputMode,
        input_observation: inputObservation,
        ...(inputState
          ? {
              input_state: {
                user_control_active: inputState.userControlActive,
                cleanup_state: inputState.cleanupState,
                reason: inputState.takeoverReason || '',
              },
            }
          : {}),
        focus_cursor_restore: false,
        focus_recovery: 'session_release',
        cursor_recovery: 'restore_position_and_appearance',
        app_owned_electron_text: true,
        browser_content_route: 'preserve_selected_session',
        capture_probe: 'run capture against an exact target; diagnostics does not expose screen pixels',
      },
      permissions: {
        screen_capture: 'not_required_on_windows',
        accessibility: 'not_required_on_windows',
        input: 'target_integrity_dependent',
      },
      displays: diagnosis.displays,
      issues: diagnoseIssues(diagnosis),
      timings_ms: { total_ms: elapsedMs(diagnosis.startedAt) },
    }),
  };
}

export function createInspection(host: InspectHost) {
  const { readComputerWindows, readDisplays, isObserveOnly } = host;

  async function diagnoseComputer(command: ComputerCommand): Promise<ComputerCommandResult> {
    assertOcrLanguageTag(command.ocr_language);
    const startedAt = performance.now();
    const windows = await readComputerWindows(command, true);
    const requestedWindowId = String(command.window_id || '');
    const target = requestedWindowId
      ? windows?.find((window) => window.id === requestedWindowId)
      : windows?.find((window) => window.focused);
    const accessibility = await probeAccessibility(host, command, target);
    const ocr = await probeOcr(host, command);
    const inputObservation = await probeInputObservation(host, command);
    const displays = readDisplays();
    const inputState = host.readInputState?.();
    const inputBlocked = Boolean(
      inputState?.userControlActive || (inputState?.cleanupState && inputState.cleanupState !== 'ready')
    );
    return diagnoseReport({
      command,
      startedAt,
      windows,
      requestedWindowId,
      target,
      accessibility,
      ocr,
      inputObservation,
      displays,
      inputState,
      inputBlocked,
      observeOnly: isObserveOnly(),
    });
  }

  return {
    diagnoseComputer,
    verifyWindowState: (command: ComputerCommand) => verifyWindowState(host, command),
  };
}
