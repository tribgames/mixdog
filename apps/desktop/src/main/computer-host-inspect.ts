/**
 * The read-only questions Computer Use can answer: whether the backend, OCR and
 * accessibility are ready, and whether a bounded condition has become true. A
 * wait reads predicate state only, so it never invalidates the refs the caller
 * is holding and never returns pixels.
 */
import { screen } from 'electron';

import { elapsedMs } from './computer-host-shared';
import { evaluateVerifyPredicate, screenshotInteger, type VerifyStatus } from './computer-host-observation';
import type { ComputerWindowRecord } from './computer-window-transition';
import type { ComputerCommand, ComputerCommandResult } from './computer-host-types';

const DEFAULT_VERIFY_TIMEOUT_MS = 5_000;
const MAX_VERIFY_TIMEOUT_MS = 30_000;
const DEFAULT_VERIFY_STABLE_SAMPLES = 2;
const VERIFY_POLL_INTERVAL_MS = 250;

export interface InspectHost {
  callPowerShell(request: Record<string, unknown>): Promise<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }>;
  sessionIdFor(command: ComputerCommand): string;
  assertExecutionNotAborted(): void;
  readComputerWindows(
    command: ComputerCommand,
    includeApp?: boolean,
  ): Promise<ComputerWindowRecord[] | null>;
  isObserveOnly(): boolean;
}

export function createInspection(host: InspectHost) {
  const {
    callPowerShell,
    sessionIdFor,
    assertExecutionNotAborted,
    readComputerWindows,
    isObserveOnly,
  } = host;

  async function diagnoseComputer(command: ComputerCommand): Promise<ComputerCommandResult> {
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
        const probe = await callPowerShell({
          action: 'snapshot',
          window_id: target.id,
          max_elements: 1,
          visible_only: true,
          session_id: sessionIdFor(command),
          read_only: true,
        });
        accessibility = probe.ok
          ? {
              available: true,
              target_window_id: target.id,
              returned_elements: Array.isArray(probe.result?.elements)
                ? probe.result.elements.length
                : 0,
            }
          : {
              available: false,
              target_window_id: target.id,
              reason: probe.error || 'accessibility probe failed',
            };
      } catch (error) {
        accessibility = {
          available: false,
          target_window_id: target.id,
          reason: (error as Error).message || String(error),
        };
      }
    }
    let ocr: Record<string, unknown>;
    try {
      const probe = await callPowerShell({
        action: 'ocr_status',
        ocr_language: command.ocr_language ?? null,
        session_id: sessionIdFor(command),
        read_only: true,
      });
      ocr = probe.ok
        ? {
            available: probe.result?.available === true,
            requested_language: probe.result?.requested_language ?? null,
            active_language: probe.result?.active_language ?? null,
            installed_languages: Array.isArray(probe.result?.installed_languages)
              ? probe.result.installed_languages
              : [],
          }
        : { available: false, reason: probe.error || 'OCR readiness probe failed' };
    } catch (error) {
      ocr = { available: false, reason: (error as Error).message || String(error) };
    }
    const displays = screen.getAllDisplays().map((display, index) => ({
      index,
      id: String(display.id),
      primary: display.id === screen.getPrimaryDisplay().id,
      scale_factor: display.scaleFactor,
      width: display.size.width,
      height: display.size.height,
    }));
    const issues: string[] = [];
    if (!windows) issues.push('window enumeration failed');
    if (requestedWindowId && !target) issues.push(`requested window is unavailable: ${requestedWindowId}`);
    if (accessibility.available === false) issues.push(String(accessibility.reason || 'accessibility unavailable'));
    if (command.ocr_language && ocr.available !== true) {
      issues.push(`Windows OCR language is unavailable: ${command.ocr_language}`);
    }
    return {
      text: JSON.stringify({
        ok: windows !== null,
        action: 'diagnose',
        platform: 'win32',
        ready: windows !== null,
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
          input_mode: isObserveOnly() ? 'observation_only' : 'enabled',
          focus_cursor_restore: true,
          app_owned_electron_text: true,
          browser_content_route: 'browser_use',
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
    const predicates = (Array.isArray(command.expect) ? command.expect : [])
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    if (predicates.length < 1 || predicates.length > 8) {
      throw new Error('verify requires 1..8 predicates');
    }
    const timeoutMs = screenshotInteger(
      command.timeout_ms,
      DEFAULT_VERIFY_TIMEOUT_MS,
      0,
      MAX_VERIFY_TIMEOUT_MS,
      'timeout_ms',
    );
    const stableSamples = screenshotInteger(
      command.stable_samples,
      DEFAULT_VERIFY_STABLE_SAMPLES,
      1,
      5,
      'stable_samples',
    );
    const deadline = startedAt + timeoutMs;
    let samples = 0;
    let consecutive = 0;
    let statuses: VerifyStatus[] = predicates.map(() => 'unknown');
    let title = '';
    let observedElements = 0;
    const needsElementText = predicates.some(
      (predicate) => typeof (predicate as Record<string, unknown>).present === 'string'
        || typeof (predicate as Record<string, unknown>).absent === 'string',
    );
    for (;;) {
      assertExecutionNotAborted();
      const response = await callPowerShell({
        action: 'window_predicates',
        window: command.window ?? null,
        window_id: command.window_id ?? null,
        max_elements: 400,
        include_elements: needsElementText,
        session_id: sessionIdFor(command),
        read_only: true,
      });
      samples += 1;
      const elements = (Array.isArray(response.result?.elements)
        ? response.result.elements
        : []) as Array<Record<string, unknown>>;
      observedElements = elements.length;
      title = String(response.result?.title || title);
      const observation = {
        ok: response.ok === true,
        exists: response.ok === true && response.result?.exists !== false,
        title,
        haystack: elements
          .map((element) => `${String(element.name || '')} ${String(element.value || '')}`)
          .join('\n')
          .toLowerCase(),
      };
      statuses = predicates.map(
        (predicate) => evaluateVerifyPredicate(predicate as Record<string, unknown>, observation),
      );
      consecutive = statuses.every((status) => status === 'satisfied') ? consecutive + 1 : 0;
      if (consecutive >= stableSamples) break;
      if (performance.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(VERIFY_POLL_INTERVAL_MS, Math.max(1, deadline - performance.now())),
      ));
    }
    const decision: VerifyStatus = consecutive >= stableSamples
      ? 'satisfied'
      : statuses.some((status) => status === 'unknown') ? 'unknown' : 'unsatisfied';
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
