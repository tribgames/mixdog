/**
 * Replay of `native/core/fixtures/error-presentation-cases/golden.json` (Node b6f10295a, shared/error-presentation.test.mjs)
 * against the code the renderer still runs: `describeError` / `safeErrorDetails` (ErrorNotice.tsx, desktop-toast-state.ts,
 * RendererRecovery.tsx import src/runtime/shared/error-presentation.mjs), `presentErrorText`, `providerErrorKind` and the
 * Error the recorder builds from each spec. Every recorded probe (describe, present, safeDetails, builtError,
 * providerErrorKind, persistedDescribe, summaryReDescribe; inputs E, T, Q, D, S) is rebuilt from its recorded input and the
 * whole probe compared in exact form, plus the three values recorded outside probes (the two fingerprints, the
 * redaction texts, the 40 000-character notice). The core's side (present, safeDetails, the kind) is replayed in
 * mixdog-ai service/error_presentation_replay_tests.rs. The recording is read at run time.
 */
process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock, test } from 'node:test';

import { exact, fromExact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { anthropicQuotaError } from '../../../../src/runtime/agent/orchestrator/providers/anthropic-oauth-request/initial-status.mjs';
import { providerErrorKind } from '../../../../src/runtime/agent/orchestrator/providers/provider-error-kind.mjs';
import { presentErrorText } from '../../../../src/runtime/shared/err-text.mjs';
import { describeError, safeErrorDetails } from '../../../../src/runtime/shared/error-presentation.mjs';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '../../../../native/core/fixtures/error-presentation-cases/golden.json');
const recording = JSON.parse(readFileSync(GOLDEN, 'utf8'));
const FIXED_NOW = recording.clock.dateNow;

const build = (spec) => {
  switch (spec.t) {
    case 'E': return Object.assign(new Error(spec.message), spec.fields);
    case 'T': return Object.assign(new TypeError(spec.message), spec.fields);
    case 'Q': return anthropicQuotaError(spec.status, new Map(spec.headers), spec.body);
    case 'D': return { message: spec.message, errorKind: spec.errorKind };
    case 'S': return spec.text;
    default: throw new Error(`bad spec ${spec.t}`);
  }
};
const safe = (fn) => {
  try {
    return fn();
  } catch (error) {
    return { threw: error };
  }
};

/** Everything the renderer's modules answer for one recorded input (the recorder's `probe`). */
function replayProbe(spec) {
  const value = build(spec);
  const out = { input: spec, describe: safe(() => describeError(value)), present: safe(() => presentErrorText(value)), safeDetails: safe(() => safeErrorDetails(spec.t === 'S' ? spec.text : value)) };
  if (spec.t === 'E' || spec.t === 'T' || spec.t === 'Q') {
    out.builtError = value;
    out.providerErrorKind = safe(() => providerErrorKind(value));
    out.persistedDescribe = safe(() => describeError({ message: value.message, errorKind: providerErrorKind(value) }));
  }
  if (out.describe && typeof out.describe === 'object' && typeof out.describe.summary === 'string') {
    out.summaryReDescribe = safe(() => describeError(out.describe.summary));
  }
  return out;
}

const isProbe = (value) => value && typeof value === 'object' && !Array.isArray(value) && 'input' in value && 'present' in value && typeof value.input?.t === 'string';
function probesOf(value, path, out) {
  if (isProbe(value)) out.push([path, value]);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) probesOf(child, `${path}.${key}`, out);
  return out;
}
const caseOf = (title) => recording.cases.find((entry) => entry.case.startsWith(title)).observed;

test.before(() => mock.timers.enable({ apis: ['Date'], now: FIXED_NOW }));
test.after(() => mock.timers.reset());

test('every recorded probe reads the same through the renderer’s modules, whole', () => {
  const probes = probesOf(recording.cases.map((entry) => entry.observed), 'cases', []);
  assert.ok(probes.length > 100, `only ${probes.length} probes found`);
  const failures = [];
  for (const [path, recorded] of probes) {
    const { name, ...want } = recorded;
    const got = exact(replayProbe(fromExact(recorded.input)));
    try {
      assert.deepEqual(got, want);
    } catch (error) {
      failures.push(`${path} (${name ?? ''}): ${error.message.slice(0, 600)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('the values recorded beside the probes: ordinary fingerprints, the redaction texts, the bounded notice', () => {
  const fingerprints = caseOf('typed failures distinguish').fingerprintsOfOrdinaryFailures;
  assert.deepEqual(
    [describeError(new Error('ordinary failure A')).fingerprint, describeError(new Error('ordinary failure B')).fingerprint],
    fingerprints
  );

  const redaction = caseOf('both summaries and details redact');
  const raw = fromExact(redaction.raw);
  const result = replayProbe(fromExact(redaction.result.input));
  assert.deepEqual(exact([result.describe.summary, result.describe.details, safeErrorDetails(raw), presentErrorText(new Error(raw))]), redaction.texts);
  assert.equal(safeErrorDetails(raw), redaction.safeDetailsOfString);
  assert.equal(presentErrorText(new Error(raw)), redaction.presentErrorText);

  const bounded = caseOf('diagnostic payloads and display summaries');
  assert.deepEqual(exact(describeError(new Error(`Failure ${'x'.repeat(40_000)}`))), bounded.result);
  assert.equal(safeErrorDetails(`{"data":"${'a'.repeat(1000)}"}`), bounded.safeDataOfLongJson);
});
