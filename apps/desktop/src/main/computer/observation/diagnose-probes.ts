/**
 * The readiness probes `diagnose` runs against the native side: whether the
 * target exposes semantic accessibility, whether Windows OCR has the requested
 * language, and whether the input observer sees an idle desktop. Each probe
 * answers in place — a failure is a finding, never an error out of diagnose.
 */
import type { ComputerCommand } from '../shared/types';
import type { ComputerWindowRecord } from '../shared/window-transition';
import type { InspectHost } from './inspect';

const DIAGNOSE_ACCESSIBILITY_TIMEOUT_MS = 2_500;
const DIAGNOSE_OCR_TIMEOUT_MS = 3_000;

export type DiagnoseProbeHost = Pick<InspectHost, 'callPowerShell' | 'sessionIdFor'>;
export type ProbeReport = Record<string, unknown>;

const failureMessage = (error: unknown) => (error as Error).message || String(error);

export async function probeAccessibility(
  host: DiagnoseProbeHost,
  command: ComputerCommand,
  target: ComputerWindowRecord | undefined
): Promise<ProbeReport> {
  if (!target) return { available: null, reason: 'no exact or foreground target was available' };
  try {
    // A readiness probe stops at the first interactive element. A snapshot
    // walks the whole tree (a busy page overran the budget and restarted the
    // input host on every diagnose) and replaces the session's refs.
    const probe = await host.callPowerShell(
      {
        action: 'accessibility_probe',
        window_id: target.id,
        session_id: host.sessionIdFor(command),
        read_only: true,
      },
      DIAGNOSE_ACCESSIBILITY_TIMEOUT_MS
    );
    const returnedElements = probe.result?.interactive === true ? 1 : 0;
    if (!probe.ok) {
      return {
        available: false,
        provider_available: false,
        state: 'error',
        target_window_id: target.id,
        reason: probe.error || 'accessibility probe failed',
      };
    }
    if (returnedElements > 0) {
      return {
        available: true,
        provider_available: true,
        state: 'usable',
        target_window_id: target.id,
        returned_elements: returnedElements,
      };
    }
    return {
      available: false,
      provider_available: true,
      state: 'empty',
      target_window_id: target.id,
      returned_elements: 0,
      reason: 'target exposes no semantic accessibility elements; state capture will use OCR/pixels',
      fallback: 'ocr_or_pixels',
    };
  } catch (error) {
    return {
      available: false,
      provider_available: false,
      state: 'error',
      target_window_id: target.id,
      reason: failureMessage(error),
    };
  }
}

export async function probeOcr(host: DiagnoseProbeHost, command: ComputerCommand): Promise<ProbeReport> {
  try {
    const probe = await host.callPowerShell(
      {
        action: 'ocr_status',
        ocr_language: command.ocr_language ?? null,
        session_id: host.sessionIdFor(command),
        read_only: true,
      },
      DIAGNOSE_OCR_TIMEOUT_MS
    );
    if (!probe.ok) return { available: false, reason: probe.error || 'OCR readiness probe failed' };
    return {
      available: probe.result?.available === true,
      requested_language: probe.result?.requested_language ?? null,
      active_language: probe.result?.active_language ?? null,
      installed_languages: Array.isArray(probe.result?.installed_languages) ? probe.result.installed_languages : [],
    };
  } catch (error) {
    return { available: false, reason: failureMessage(error) };
  }
}

export async function probeInputObservation(host: DiagnoseProbeHost, command: ComputerCommand): Promise<ProbeReport> {
  try {
    const probe = await host.callPowerShell(
      {
        action: 'input_idle_state',
        session_id: host.sessionIdFor(command),
        read_only: true,
      },
      DIAGNOSE_ACCESSIBILITY_TIMEOUT_MS
    );
    return {
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
    return { ready: false, error: failureMessage(error) };
  }
}
