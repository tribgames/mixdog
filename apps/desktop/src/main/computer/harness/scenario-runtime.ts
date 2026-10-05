import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, screen } from 'electron';
import { createPolling } from '../../host-harness-poll';
import { SCENARIO_IDS } from './scenario-ids';
import { isScenarioUserControl } from './scenario-user-control';
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';
import type { CommandResult, ScenarioMetrics, ScenarioResult, BridgeDiscovery, ActionMetrics } from './scenario-types';

export class ScenarioSkip extends Error {}

export const progressPath = process.env.MIXDOG_COMPUTER_SCENARIO_LOG || '';
export const reportPath = process.env.MIXDOG_COMPUTER_SCENARIO_REPORT || '';
export const reportDirectory = process.env.MIXDOG_COMPUTER_SCENARIO_REPORT_DIR || '';
export const sequencePerformancePath = process.env.MIXDOG_COMPUTER_SEQUENCE_REPORT || '';
export const reportLabel = process.env.MIXDOG_COMPUTER_SCENARIO_LABEL || 'baseline';
export const scenarioOnly = new Set(
  String(process.env.MIXDOG_COMPUTER_SCENARIO_ONLY || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
export const skipForeground = process.env.MIXDOG_COMPUTER_SCENARIO_SKIP_FOREGROUND === '1';
export let foregroundSkipped = false;
export let userInterventionSeen = false;
export const profile = String(process.env.MIXDOG_COMPUTER_SCENARIO_PROFILE || '');
if (!profile) throw new Error('MIXDOG_COMPUTER_SCENARIO_PROFILE is required');
export const dataDirectory = join(profile, 'data');
mkdirSync(dataDirectory, { recursive: true });
process.env.MIXDOG_DATA_DIR = dataDirectory;
app.setPath('userData', join(profile, 'user-data'));

export let activeMetrics: ScenarioMetrics | null = null;
export let previousCommandHadCaptureAfter = false;
export const results: ScenarioResult[] = [];
export const OBSERVATION_ACTIONS = new Set([
  'list_windows',
  'list_apps',
  'diagnose',
  'capture',
  'snapshot',
  'find',
  'screenshot',
  'zoom',
  'clipboard_read',
  'wait',
  'verify',
  'window_predicates',
]);
export const MUTATION_ACTIONS = new Set([
  'invoke',
  'set_value',
  'toggle',
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'triple_click',
  'mouse_down',
  'mouse_up',
  'mouse_move',
  'drag',
  'type',
  'key',
  'key_down',
  'key_up',
  'scroll',
  'focus_window',
  'move_window',
  'window_state',
  'close_window',
  'clipboard_write',
  'launch',
  'sequence',
  'invoke_menu',
]);
export const declaredScenarioIds = new Set<string>();

export function progress(message: string): void {
  if (progressPath) appendFileSync(progressPath, `${message}\n`);
}

export function emptyMetrics(): ScenarioMetrics {
  return {
    commands: 0,
    cleanup_commands: 0,
    observations: 0,
    mutations: 0,
    accepted_mutations: 0,
    post_action_recaptures: 0,
    retries: 0,
    request_bytes: 0,
    response_text_bytes: 0,
    image_bytes: 0,
    max_returned_elements: 0,
    escalations: [],
    false_positive: false,
    phase_ms: {},
    actions: {},
  };
}

export const { eventually, readDiscovery } = createPolling({
  timeoutMs: 20_000,
  intervalMs: 120,
  onRetry: () => {
    if (activeMetrics) activeMetrics.retries += 1;
  },
});

export async function runScenario(
  id: string,
  name: string,
  area: string,
  operation: () => Promise<void>
): Promise<void> {
  if (declaredScenarioIds.has(id)) throw new Error(`duplicate scenario declaration: ${id}`);
  if (!SCENARIO_IDS.includes(id)) throw new Error(`scenario id is missing from SCENARIO_IDS: ${id}`);
  declaredScenarioIds.add(id);
  if (scenarioOnly.size && !scenarioOnly.has(id)) return;
  const metrics = emptyMetrics();
  activeMetrics = metrics;
  previousCommandHadCaptureAfter = false;
  const startedAt = Date.now();
  let status: ScenarioResult['status'] = 'pass';
  let failure = '';
  foregroundSkipped = false;
  userInterventionSeen = false;
  try {
    await operation();
    // An assertion can swallow the skip signal, so what was requested decides
    // the outcome, not only whether the skip error reached this frame.
    if (foregroundSkipped || userInterventionSeen) status = 'skip';
  } catch (error) {
    failure = (error as Error).message || String(error);
    // The host pausing for the user is an environment fact, not a defect. Record
    // it as unmeasured so a real failure stays visible next to it.
    const userControlled = isScenarioUserControl(computerErrorCode(error));
    userInterventionSeen ||= userControlled;
    status =
      error instanceof ScenarioSkip || foregroundSkipped || userControlled || userInterventionSeen ? 'skip' : 'fail';
    metrics.false_positive = status === 'fail' && metrics.accepted_mutations > 0;
  } finally {
    activeMetrics = null;
  }
  results.push({
    id,
    name,
    area,
    status,
    duration_ms: Date.now() - startedAt,
    ...metrics,
    ...(failure ? { failure } : {}),
  });
  progress(`${id} ${status.toUpperCase()} ${name}${failure ? ` — ${failure}` : ''}`);
  if (userInterventionSeen) {
    throw new Error('computer_user_intervention_pending: scenario matrix stopped while the user has control');
  }
}

export function isScenarioDeclared(id: string): boolean {
  return declaredScenarioIds.has(id);
}

export function skip(message: string): never {
  throw new ScenarioSkip(message);
}

/**
 * Folds one command response into the active scenario metrics: byte and
 * duration accounting, then whatever the structured payload says about user
 * intervention, element budgets, phase timings and escalations.
 */
export function recordCommandResponse(
  actionName: string,
  value: CommandResult,
  actionMetrics: ActionMetrics | null,
  durationMs: number
): void {
  const metrics = activeMetrics;
  if (!metrics) return;
  const responseTextBytes = Buffer.byteLength(value.text);
  const imageBytes = value.image?.data ? Math.floor(value.image.data.length * 0.75) : 0;
  metrics.response_text_bytes += responseTextBytes;
  metrics.image_bytes += imageBytes;
  if (actionMetrics) {
    actionMetrics.durations_ms.push(durationMs);
    actionMetrics.response_text_bytes += responseTextBytes;
    actionMetrics.image_bytes += imageBytes;
  }
  try {
    const parsed = JSON.parse(value.text) as Record<string, unknown>;
    // A parked request answers at the bridge level, so the intervention is
    // only visible in the body. Later assertions in the same scenario are
    // measuring a desktop the user owns, not the behaviour under test.
    if (isScenarioUserControl(parsed.code)) {
      userInterventionSeen = true;
    }
    metrics.max_returned_elements = Math.max(
      metrics.max_returned_elements,
      Number(parsed.returned_elements) || 0,
      Number((parsed.capture_after as Record<string, unknown> | undefined)?.returned_elements) || 0
    );
    if (MUTATION_ACTIONS.has(actionName) && parsed.delivery_accepted === true) {
      metrics.accepted_mutations += 1;
    }
    previousCommandHadCaptureAfter = Boolean(
      MUTATION_ACTIONS.has(actionName) && (parsed.capture_after as Record<string, unknown> | undefined)?.ok
    );
    const addTimings = (prefix: string, value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, timing] of Object.entries(value as Record<string, unknown>)) {
        const numeric = Number(timing);
        if (!Number.isFinite(numeric)) continue;
        const name = `${prefix}${key}`;
        metrics.phase_ms[name] = Number(((metrics.phase_ms[name] || 0) + numeric).toFixed(2));
      }
    };
    addTimings('', parsed.timings_ms);
    addTimings('capture_after.', (parsed.capture_after as Record<string, unknown> | undefined)?.timings_ms);
    for (const escalation of [
      parsed.escalation,
      (parsed.verdict as Record<string, unknown> | undefined)?.recommended,
    ]) {
      if (typeof escalation === 'string' && !metrics.escalations.includes(escalation)) {
        metrics.escalations.push(escalation);
      }
    }
  } catch {
    // Plain-text discovery results intentionally have no structured metrics.
  }
}

/**
 * One scenario command: classification and request accounting, the bridge
 * round trip, and the response folded back into the active metrics. The
 * discovery accessor is read per call because a bridge restart republishes it.
 */
export function createScenarioCommand(
  session: string,
  discovery: () => BridgeDiscovery
): (input: Record<string, unknown>, sessionId?: string) => Promise<CommandResult> {
  return async (input: Record<string, unknown>, sessionId = session): Promise<CommandResult> => {
    const body = JSON.stringify({ session_id: sessionId, ...input });
    const actionName = String(input.action || '');
    // Sequence steps carry their delivery in the same body, so one check covers them.
    if (skipForeground && body.includes('"delivery":"foreground"')) {
      foregroundSkipped = true;
      throw new ScenarioSkip('foreground delivery takes the real pointer; skipped by request');
    }
    const isCleanup =
      actionName === 'session_release' || actionName === 'session_abort' || actionName === 'execution_end';
    const isObservation = OBSERVATION_ACTIONS.has(actionName);
    const isMutation = MUTATION_ACTIONS.has(actionName);
    if (!isCleanup && isObservation === isMutation) {
      throw new Error(`scenario action '${actionName}' must be classified as exactly one of observation or mutation`);
    }
    const commandStartedAt = performance.now();
    const requestBytes = Buffer.byteLength(body);
    if (activeMetrics) {
      activeMetrics.actions[actionName] ||= {
        commands: 0,
        failures: 0,
        durations_ms: [],
        request_bytes: 0,
        response_text_bytes: 0,
        image_bytes: 0,
      };
    }
    const actionMetrics = activeMetrics ? activeMetrics.actions[actionName] : null;
    if (activeMetrics) {
      activeMetrics.commands += 1;
      activeMetrics.request_bytes += requestBytes;
      if (isCleanup) activeMetrics.cleanup_commands += 1;
      if (actionMetrics) {
        actionMetrics.commands += 1;
        actionMetrics.request_bytes += requestBytes;
      }
      if (isObservation) activeMetrics.observations += 1;
      if (isMutation) activeMetrics.mutations += 1;
      if (actionName === 'capture' && previousCommandHadCaptureAfter) {
        activeMetrics.post_action_recaptures += 1;
      }
    }
    previousCommandHadCaptureAfter = false;
    const response = await fetch(`http://127.0.0.1:${discovery().port}/command`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${discovery().token}`,
        'content-type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(45_000),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      value?: CommandResult;
      error?: string;
    };
    if (!payload.ok) {
      if (isScenarioUserControl(computerErrorCode(payload.error))) userInterventionSeen = true;
      if (actionMetrics) {
        actionMetrics.failures += 1;
        actionMetrics.durations_ms.push(Math.round(performance.now() - commandStartedAt));
      }
      throw new Error(payload.error || 'computer command failed');
    }
    const value = {
      text: String(payload.value?.text || ''),
      ...(payload.value?.image ? { image: payload.value.image } : {}),
    };
    recordCommandResponse(actionName, value, actionMetrics, Math.round(performance.now() - commandStartedAt));
    if (userInterventionSeen && !isCleanup) {
      throw new ScenarioSkip('user input interrupted the command; no further input is authorized');
    }
    return value;
  };
}

/** Aggregates the matrix into the report artifact and the closing summary. */
export function writeScenarioReport(displayPlacement: string): void {
  if (reportDirectory) mkdirSync(reportDirectory, { recursive: true });
  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail').length;
  const skipped = results.filter((result) => result.status === 'skip').length;
  const totalDuration = results.reduce((sum, result) => sum + result.duration_ms, 0);
  const totalCommands = results.reduce((sum, result) => sum + result.commands, 0);
  const cleanupCommands = results.reduce((sum, result) => sum + result.cleanup_commands, 0);
  const report = {
    schema_version: 1,
    label: reportLabel,
    generated_at: new Date().toISOString(),
    environment: {
      platform: process.platform,
      electron: process.versions.electron,
      windows_displays: screen.getAllDisplays().length,
      fixture_placement: displayPlacement,
    },
    summary: {
      total: results.length,
      passed,
      failed,
      skipped,
      success_rate: results.length ? passed / results.length : 0,
      duration_ms: totalDuration,
      commands: totalCommands,
      tool_calls: totalCommands - cleanupCommands,
      cleanup_commands: cleanupCommands,
      observations: results.reduce((sum, result) => sum + result.observations, 0),
      mutations: results.reduce((sum, result) => sum + result.mutations, 0),
      accepted_mutations: results.reduce((sum, result) => sum + result.accepted_mutations, 0),
      post_action_recaptures: results.reduce((sum, result) => sum + result.post_action_recaptures, 0),
      false_positives: results.filter((result) => result.false_positive).length,
      retries: results.reduce((sum, result) => sum + result.retries, 0),
      response_text_bytes: results.reduce((sum, result) => sum + result.response_text_bytes, 0),
      image_bytes: results.reduce((sum, result) => sum + result.image_bytes, 0),
      phase_ms: results.reduce<Record<string, number>>((totals, result) => {
        for (const [name, timing] of Object.entries(result.phase_ms)) {
          totals[name] = Number(((totals[name] || 0) + timing).toFixed(2));
        }
        return totals;
      }, {}),
    },
    results,
  };
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  progress('scenario matrix complete');
  console.log(
    `Computer Use scenario matrix complete: ${passed}/${results.length} passed,` +
      ` ${failed} failed, ${skipped} skipped.`
  );
}
