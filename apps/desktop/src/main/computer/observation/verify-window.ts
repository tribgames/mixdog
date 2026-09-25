/**
 * A bounded wait for a window condition: the predicates are read against the
 * window's title and element text until they hold for enough consecutive
 * samples or the budget ends. It reads predicate state only, so it never
 * invalidates the refs the caller is holding and never returns pixels.
 */
import { elapsedMs } from '../shared/common';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { evaluateVerifyPredicate, screenshotInteger, type VerifyStatus } from './analysis';
import { verifyUnknownReason } from './verify-predicate';
import type { InspectHost } from './inspect';

const DEFAULT_VERIFY_TIMEOUT_MS = 5_000;
const MAX_VERIFY_TIMEOUT_MS = 30_000;
const DEFAULT_VERIFY_STABLE_SAMPLES = 2;
const VERIFY_POLL_INTERVAL_MS = 250;
const VERIFY_PROVIDER_TIMEOUT_MS = 2_000;
// What an undecided text wait returns of the last read, so the caller sees why
// the text did not match without spending a capture on it.
const VERIFY_TEXT_SAMPLE_ENTRIES = 12;
const VERIFY_TEXT_SAMPLE_CHARS = 60;

export type VerifyHost = Pick<InspectHost, 'callPowerShell' | 'sessionIdFor' | 'assertExecutionNotAborted'>;

type Predicate = Record<string, unknown>;

interface VerifyState {
  samples: number;
  /** Samples in a row where every predicate held. */
  consecutive: number;
  statuses: VerifyStatus[];
  title: string;
  exists: boolean;
  observedElements: number;
  textComplete: boolean;
  textSample: string[];
  providerError: string;
}

function elementTextSample(elements: Array<Record<string, unknown>>): string[] {
  const sample: string[] = [];
  for (const element of elements) {
    const text = `${String(element.name || '')} ${String(element.value || '')}`
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, VERIFY_TEXT_SAMPLE_CHARS);
    if (!text || sample.includes(text)) continue;
    sample.push(text);
    if (sample.length >= VERIFY_TEXT_SAMPLE_ENTRIES) break;
  }
  return sample;
}

function verifyPredicates(command: ComputerCommand): Predicate[] {
  const predicates = (Array.isArray(command.expect) ? command.expect : []).filter(
    (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  );
  if (predicates.length < 1 || predicates.length > 8) {
    throw new Error('verify requires 1..8 predicates');
  }
  return predicates as Predicate[];
}

/** One provider read judged against every predicate. False when the provider
 *  failed: polling stops and the predicates stay unknown. */
async function samplePredicates(
  host: VerifyHost,
  command: ComputerCommand,
  predicates: Predicate[],
  needsElementText: boolean,
  state: VerifyState
): Promise<boolean> {
  let response: Awaited<ReturnType<VerifyHost['callPowerShell']>>;
  try {
    response = await host.callPowerShell(
      {
        action: 'window_predicates',
        window: command.window ?? null,
        window_id: command.window_id ?? null,
        max_elements: 400,
        include_elements: needsElementText,
        session_id: host.sessionIdFor(command),
        read_only: true,
      },
      VERIFY_PROVIDER_TIMEOUT_MS
    );
  } catch (error) {
    state.providerError = (error as Error).message || String(error);
    state.statuses = predicates.map(() => 'unknown');
    return false;
  }
  state.samples += 1;
  if (!response.ok) {
    state.providerError = response.error || 'window predicate provider failed';
    state.statuses = predicates.map(() => 'unknown');
    return false;
  }
  const elements = (Array.isArray(response.result?.elements) ? response.result.elements : []) as Array<
    Record<string, unknown>
  >;
  state.observedElements = elements.length;
  state.textComplete = response.result?.text_complete === true && state.observedElements > 0;
  state.title = String(response.result?.title || '');
  state.exists = response.result?.exists !== false;
  state.textSample = elementTextSample(elements);
  const observation = {
    ok: response.ok === true,
    exists: state.exists,
    title: state.title,
    textComplete: state.textComplete,
    haystack: elements
      .map((element) => `${String(element.name || '')} ${String(element.value || '')}`)
      .join('\n')
      .toLowerCase(),
  };
  state.statuses = predicates.map((predicate) => evaluateVerifyPredicate(predicate, observation));
  state.consecutive = state.statuses.every((status) => status === 'satisfied') ? state.consecutive + 1 : 0;
  return true;
}

export async function verifyWindowState(host: VerifyHost, command: ComputerCommand): Promise<ComputerCommandResult> {
  const startedAt = performance.now();
  const predicates = verifyPredicates(command);
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
  const needsElementText = predicates.some(
    (predicate) => typeof predicate.present === 'string' || typeof predicate.absent === 'string'
  );
  const state: VerifyState = {
    samples: 0,
    consecutive: 0,
    statuses: predicates.map(() => 'unknown'),
    title: '',
    exists: true,
    observedElements: 0,
    textComplete: false,
    textSample: [],
    providerError: '',
  };
  // A closed exact window never reopens under the same handle, so once it is
  // gone an unmet predicate can no longer change and waiting is pointless.
  let targetClosed = false;
  for (;;) {
    host.assertExecutionNotAborted();
    // The polling deadline is not a provider-health deadline. Even a one-shot
    // read needs its normal bounded budget; a final 1ms request would retire a
    // healthy worker and discard the evidence from earlier samples.
    if (state.samples > 0 && performance.now() >= deadline) break;
    if (!(await samplePredicates(host, command, predicates, needsElementText, state))) break;
    if (state.consecutive >= stableSamples) break;
    if (command.window_id && !state.exists && state.statuses.some((status) => status !== 'satisfied')) {
      targetClosed = true;
      break;
    }
    if (performance.now() >= deadline) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(VERIFY_POLL_INTERVAL_MS, Math.max(1, deadline - performance.now())))
    );
  }
  let decision: VerifyStatus = 'unsatisfied';
  if (state.consecutive >= stableSamples) decision = 'satisfied';
  else if (state.statuses.some((status) => status === 'unknown')) decision = 'unknown';
  const unknownReason =
    decision === 'unknown'
      ? verifyUnknownReason({
          needsElementText,
          providerError: state.providerError,
          textComplete: state.textComplete,
          observedElements: state.observedElements,
        })
      : null;
  let undecidedFields = {};
  if (targetClosed) {
    undecidedFields = {
      target_closed: true,
      unknown_hint: 'the exact window closed before the wait was decided; list windows to find its replacement',
    };
  } else if (unknownReason) {
    undecidedFields = { unknown_reason: unknownReason.reason, unknown_hint: unknownReason.hint };
  }
  return {
    text: JSON.stringify({
      ok: decision === 'satisfied',
      action: 'verify',
      decision,
      ...(command.window_id ? { window_id: String(command.window_id) } : {}),
      ...(state.title ? { title: state.title } : {}),
      samples: state.samples,
      stable_samples: stableSamples,
      observed_elements: state.observedElements,
      ...(needsElementText ? { text_complete: state.textComplete } : {}),
      ...undecidedFields,
      ...(decision !== 'satisfied' && needsElementText && state.textSample.length
        ? { observed_text_sample: state.textSample }
        : {}),
      ...(state.providerError ? { provider_error: state.providerError } : {}),
      results: predicates.map((predicate, index) => ({
        predicate,
        status: state.statuses[index],
      })),
      timings_ms: { total_ms: elapsedMs(startedAt) },
    }),
  };
}
