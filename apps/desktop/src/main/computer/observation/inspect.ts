/**
 * The read-only questions Computer Use can answer: whether the backend, OCR and
 * accessibility are ready, and whether a bounded condition has become true. A
 * wait reads predicate state only, so it never invalidates the refs the caller
 * is holding and never returns pixels.
 */
import { elapsedMs } from '../shared/common';
import { assertOcrLanguageTag, evaluateVerifyPredicate, screenshotInteger, type VerifyStatus } from './analysis';
import type { ComputerWindowRecord } from '../shared/window-transition';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';

const DEFAULT_VERIFY_TIMEOUT_MS = 5_000;
const MAX_VERIFY_TIMEOUT_MS = 30_000;
const DEFAULT_VERIFY_STABLE_SAMPLES = 2;
const VERIFY_POLL_INTERVAL_MS = 250;
const DIAGNOSE_ACCESSIBILITY_TIMEOUT_MS = 2_500;
const DIAGNOSE_OCR_TIMEOUT_MS = 3_000;
const VERIFY_PROVIDER_TIMEOUT_MS = 2_000;

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

export function createInspection(host: InspectHost) {
  const { callPowerShell, sessionIdFor, assertExecutionNotAborted, readComputerWindows, readDisplays, isObserveOnly } =
    host;

  async function diagnoseComputer(command: ComputerCommand): Promise<ComputerCommandResult> {
    assertOcrLanguageTag(command.ocr_language);
    const startedAt = performance.now();
    const windows = await readComputerWindows(command, true);
    const requestedWindowId = String(command.window_id || '');
    const target = requestedWindowId
      ? windows?.find((window) => window.id === requestedWindowId)
      : windows?.find((window) => window.focused);
    let accessibility: Record<string, unknown> = {
      available: null,
      reason: target ? 'not_probed' : 'no exact or foreground target was available',
    };
    if (target) {
      try {
        const probe = await callPowerShell(
          {
            action: 'snapshot',
            window_id: target.id,
            max_elements: 1,
            visible_only: true,
            session_id: sessionIdFor(command),
            read_only: true,
          },
          DIAGNOSE_ACCESSIBILITY_TIMEOUT_MS
        );
        const returnedElements = Array.isArray(probe.result?.elements) ? probe.result.elements.length : 0;
        if (!probe.ok) {
          accessibility = {
            available: false,
            provider_available: false,
            state: 'error',
            target_window_id: target.id,
            reason: probe.error || 'accessibility probe failed',
          };
        } else if (returnedElements > 0) {
          accessibility = {
            available: true,
            provider_available: true,
            state: 'usable',
            target_window_id: target.id,
            returned_elements: returnedElements,
          };
        } else {
          accessibility = {
            available: false,
            provider_available: true,
            state: 'empty',
            target_window_id: target.id,
            returned_elements: 0,
            reason: 'target exposes no semantic accessibility elements; state capture will use OCR/pixels',
            fallback: 'ocr_or_pixels',
          };
        }
      } catch (error) {
        accessibility = {
          available: false,
          provider_available: false,
          state: 'error',
          target_window_id: target.id,
          reason: (error as Error).message || String(error),
        };
      }
    }
    let ocr: Record<string, unknown>;
    try {
      const probe = await callPowerShell(
        {
          action: 'ocr_status',
          ocr_language: command.ocr_language ?? null,
          session_id: sessionIdFor(command),
          read_only: true,
        },
        DIAGNOSE_OCR_TIMEOUT_MS
      );
      if (probe.ok) {
        ocr = {
          available: probe.result?.available === true,
          requested_language: probe.result?.requested_language ?? null,
          active_language: probe.result?.active_language ?? null,
          installed_languages: Array.isArray(probe.result?.installed_languages) ? probe.result.installed_languages : [],
        };
      } else ocr = { available: false, reason: probe.error || 'OCR readiness probe failed' };
    } catch (error) {
      ocr = { available: false, reason: (error as Error).message || String(error) };
    }
    let inputObservation: Record<string, unknown>;
    try {
      const probe = await callPowerShell(
        {
          action: 'input_idle_state',
          session_id: sessionIdFor(command),
          read_only: true,
        },
        DIAGNOSE_ACCESSIBILITY_TIMEOUT_MS
      );
      inputObservation = {
        ready:
          probe.ok === true &&
          probe.result?.observer_ready === true &&
          probe.result?.ready === true &&
          probe.result?.held === false,
        observer_ready: probe.result?.observer_ready === true,
        desktop_ready: probe.result?.ready === true,
        input_held: typeof probe.result?.held === 'boolean' ? probe.result.held : null,
        ...(typeof probe.result?.idleMs === 'number' ? { idle_ms: probe.result.idleMs } : {}),
        ...(!probe.ok ? { error: probe.error || 'input observation probe failed' } : {}),
      };
    } catch (error) {
      inputObservation = { ready: false, error: (error as Error).message || String(error) };
    }
    const displays = readDisplays();
    const inputState = host.readInputState?.();
    const inputBlocked = Boolean(
      inputState?.userControlActive || (inputState?.cleanupState && inputState.cleanupState !== 'ready')
    );
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
    if (accessibility.available === false) issues.push(String(accessibility.reason || 'accessibility unavailable'));
    if (command.ocr_language && ocr.available !== true) {
      issues.push(`Windows OCR language is unavailable: ${command.ocr_language}`);
    }
    let inputMode = 'enabled';
    if (isObserveOnly()) inputMode = 'observation_only';
    else if (inputBlocked) inputMode = 'blocked';
    return {
      text: JSON.stringify({
        ok: windows !== null,
        action: 'diagnose',
        platform: 'win32',
        ready:
          windows !== null &&
          (!requestedWindowId || Boolean(target)) &&
          !inputBlocked &&
          inputObservation.ready === true,
        backend: 'win32_uia_powershell_electron',
        windows: {
          available: windows !== null,
          count: windows?.length || 0,
          focused_window_id: windows?.find((window) => window.focused)?.id || null,
        },
        capabilities: {
          exact_window_capture: true,
          semantic_accessibility: accessibility,
          ocr,
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
        displays,
        issues,
        timings_ms: { total_ms: elapsedMs(startedAt) },
      }),
    };
  }

  async function verifyWindowState(command: ComputerCommand): Promise<ComputerCommandResult> {
    const startedAt = performance.now();
    const predicates = (Array.isArray(command.expect) ? command.expect : []).filter(
      (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    );
    if (predicates.length < 1 || predicates.length > 8) {
      throw new Error('verify requires 1..8 predicates');
    }
    const timeoutMs = screenshotInteger(
      command.timeout_ms,
      DEFAULT_VERIFY_TIMEOUT_MS,
      0,
      MAX_VERIFY_TIMEOUT_MS,
      'timeout_ms'
    );
    const stableSamples = screenshotInteger(
      command.stable_samples,
      DEFAULT_VERIFY_STABLE_SAMPLES,
      1,
      5,
      'stable_samples'
    );
    const deadline = startedAt + timeoutMs;
    let samples = 0;
    let consecutive = 0;
    let statuses: VerifyStatus[] = predicates.map(() => 'unknown');
    let title = '';
    let observedElements = 0;
    let textComplete = false;
    let providerError = '';
    const needsElementText = predicates.some(
      (predicate) =>
        typeof (predicate as Record<string, unknown>).present === 'string' ||
        typeof (predicate as Record<string, unknown>).absent === 'string'
    );
    for (;;) {
      assertExecutionNotAborted();
      // The polling deadline is not a provider-health deadline. Even a one-shot
      // read needs its normal bounded budget; a final 1ms request would retire a
      // healthy worker and discard the evidence from earlier samples.
      if (samples > 0 && performance.now() >= deadline) break;
      let response;
      try {
        response = await callPowerShell(
          {
            action: 'window_predicates',
            window: command.window ?? null,
            window_id: command.window_id ?? null,
            max_elements: 400,
            include_elements: needsElementText,
            session_id: sessionIdFor(command),
            read_only: true,
          },
          VERIFY_PROVIDER_TIMEOUT_MS
        );
      } catch (error) {
        providerError = (error as Error).message || String(error);
        statuses = predicates.map(() => 'unknown');
        break;
      }
      samples += 1;
      if (!response.ok) {
        providerError = response.error || 'window predicate provider failed';
        statuses = predicates.map(() => 'unknown');
        break;
      }
      const elements = (Array.isArray(response.result?.elements) ? response.result.elements : []) as Array<
        Record<string, unknown>
      >;
      observedElements = elements.length;
      textComplete = response.result?.text_complete === true && observedElements > 0;
      title = String(response.result?.title || '');
      const observation = {
        ok: response.ok === true,
        exists: response.ok === true && response.result?.exists !== false,
        title,
        textComplete,
        haystack: elements
          .map((element) => `${String(element.name || '')} ${String(element.value || '')}`)
          .join('\n')
          .toLowerCase(),
      };
      statuses = predicates.map((predicate) =>
        evaluateVerifyPredicate(predicate as Record<string, unknown>, observation)
      );
      consecutive = statuses.every((status) => status === 'satisfied') ? consecutive + 1 : 0;
      if (consecutive >= stableSamples) break;
      if (performance.now() >= deadline) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(VERIFY_POLL_INTERVAL_MS, Math.max(1, deadline - performance.now())))
      );
    }
    let decision: VerifyStatus = 'unsatisfied';
    if (consecutive >= stableSamples) decision = 'satisfied';
    else if (statuses.some((status) => status === 'unknown')) decision = 'unknown';
    return {
      text: JSON.stringify({
        ok: decision === 'satisfied',
        action: 'verify',
        decision,
        ...(command.window_id ? { window_id: String(command.window_id) } : {}),
        ...(title ? { title } : {}),
        samples,
        stable_samples: stableSamples,
        observed_elements: observedElements,
        ...(needsElementText ? { text_complete: textComplete } : {}),
        ...(providerError ? { provider_error: providerError } : {}),
        results: predicates.map((predicate, index) => ({
          predicate,
          status: statuses[index],
        })),
        timings_ms: { total_ms: elapsedMs(startedAt) },
      }),
    };
  }

  return { diagnoseComputer, verifyWindowState };
}
