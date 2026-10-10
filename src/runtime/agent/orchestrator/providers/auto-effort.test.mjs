import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoEffortBase,
  autoEffortLadder,
  judgedStep,
  normalizeAutoEffortMode,
  resolveAutoEffort,
} from './auto-effort.mjs';
import { prepareTurnEffortConfiguration, projectEffortConfiguration, stepEffortConfiguration } from './effort-configuration.mjs';
import { markStepEffort } from '../session/loop/step-auto-effort.mjs';
import { stepJudgeText, stepResultWindow } from '../../../effort-judge/judge-input.mjs';
import { builtinFeatureActive, INSTALLABLE_BUILTIN_IDS } from '../runtime-core/builtin-features.mjs';
import { autoEffortStepsEnabled, resolveTurnAutoEffort } from '../session/manager/ask-turn-auto-effort.mjs';

const ANTHROPIC = ['low', 'medium', 'high', 'xhigh', 'max'];
// One-hot distribution over the judge levels 0 easy .. 3 very hard.
const at = (level) => Array.from({ length: 4 }, (_, i) => (i === level ? 1 : 0));

test('the auto ladder spans low up to the tier below max/ultra, in canonical order', () => {
  assert.deepEqual(autoEffortLadder(ANTHROPIC), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(autoEffortLadder(['ultra', 'none', 'high', 'low', 'max', 'medium', 'xhigh']), [
    'low',
    'medium',
    'high',
    'xhigh',
  ]);
  assert.deepEqual(autoEffortLadder(['low', 'medium', 'high']), ['low', 'medium', 'high']);
  assert.deepEqual(autoEffortLadder([]), []);
});

test('judge levels map to steps: easy -1, normal 0, hard +1, very hard +2', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((level) => judgedStep(at(level)).step),
    [-1, 0, 1, 2]
  );
  assert.deepEqual(judgedStep([0.1, 0.2, 0.6, 0.1]), { step: 1, level: 2, confidence: 0.6 });
  // "Very hard" without a firm judge stays one step lower (high, not xhigh).
  assert.deepEqual(judgedStep([0, 0.003, 0.4, 0.597]), { step: 1, level: 2, confidence: 0.597 });
  assert.equal(judgedStep([0, 0.002, 0.169, 0.829]).step, 2);
});

test('a split judge avoids an opposite call instead of following the top level', () => {
  // Top level "easy", but enough weight on "hard" that low risks an opposite call.
  assert.equal(judgedStep([0.45, 0.2, 0.35, 0]).step, 0);
  // Top level "hard", but enough weight on "easy" that high risks an opposite call.
  assert.equal(judgedStep([0.38, 0.2, 0.42, 0]).step, 0);
});

test('calling a hard turn easy is avoided harder than calling an easy turn hard', () => {
  // The same split, mirrored: the risky low falls back to the default...
  assert.equal(judgedStep([0.7, 0.12, 0.18, 0]).step, 0);
  // ...while the merely costly high is kept.
  assert.equal(judgedStep([0.18, 0.12, 0.7, 0]).step, 1);
});

test('an unsure judge keeps the default', () => {
  const flat = Array(4).fill(1 / 4);
  assert.equal(judgedStep(flat).step, 0);
  assert.equal(judgedStep(null).step, 0);
  assert.equal(judgedStep([1, 2]).step, 0);
});

test('auto starts from medium whatever the chosen effort, except an explicit max/ultra', () => {
  for (const chosen of ['low', 'medium', 'high', 'xhigh', '']) assert.equal(autoEffortBase(chosen), 'medium');
  assert.equal(autoEffortBase('max'), 'max');
  assert.equal(autoEffortBase('ULTRA'), 'ultra');
});

test('moves are relative to the default and clamped to the ladder', () => {
  const r = (base, level) => resolveAutoEffort({ base, options: ANTHROPIC, probs: at(level) })?.effort;
  // Base medium: low for easy, high for hard, xhigh for very hard.
  assert.equal(r('medium', 0), 'low');
  assert.equal(r('medium', 1), 'medium');
  assert.equal(r('medium', 2), 'high');
  assert.equal(r('medium', 3), 'xhigh');
  // Another base moves the same steps; xhigh is the ceiling, auto never reaches max.
  assert.equal(r('high', 0), 'medium');
  assert.equal(r('high', 3), 'xhigh');
  assert.equal(r('xhigh', 3), 'xhigh');
  // A default outside the auto range is the user's explicit choice.
  assert.equal(resolveAutoEffort({ base: 'max', options: ANTHROPIC, probs: at(0) }), null);
  assert.equal(resolveAutoEffort({ base: '', options: ANTHROPIC, probs: at(1) }), null);
});

test('the Auto effort built-in is on unless the user turns it off', () => {
  const saved = process.env.MIXDOG_FEATURE_AUTO_EFFORT;
  delete process.env.MIXDOG_FEATURE_AUTO_EFFORT;
  try {
    assert.ok(INSTALLABLE_BUILTIN_IDS.includes('autoEffort'));
    // Fresh and existing profiles alike: no install step gates it.
    assert.equal(builtinFeatureActive({}, 'autoEffort'), true);
    assert.equal(builtinFeatureActive({ builtins: {} }, 'autoEffort'), true);
    assert.equal(builtinFeatureActive({ modules: { autoEffort: { enabled: true } } }, 'autoEffort'), true);
    // The user's off switch persists, installed or not.
    assert.equal(builtinFeatureActive({ modules: { autoEffort: { enabled: false } } }, 'autoEffort'), false);
    assert.equal(
      builtinFeatureActive(
        { builtins: { autoEffort: { installed: true } }, modules: { autoEffort: { enabled: false } } },
        'autoEffort'
      ),
      false
    );
    // The env override (headless runs, benchmarks) wins either way.
    process.env.MIXDOG_FEATURE_AUTO_EFFORT = '0';
    assert.equal(builtinFeatureActive({}, 'autoEffort'), false);
  } finally {
    if (saved === undefined) delete process.env.MIXDOG_FEATURE_AUTO_EFFORT;
    else process.env.MIXDOG_FEATURE_AUTO_EFFORT = saved;
  }
});

test('mode values normalize to off/observe/on', () => {
  assert.equal(normalizeAutoEffortMode('ON'), 'on');
  assert.equal(normalizeAutoEffortMode(' observe '), 'observe');
  assert.equal(normalizeAutoEffortMode('yes'), 'off');
  assert.equal(normalizeAutoEffortMode(undefined), 'off');
});

test('a per-turn effort override leaves the saved default untouched', () => {
  const session = { provider: 'anthropic-oauth', model: 'claude-opus-5-5', effort: 'high', messages: [] };
  const snapshot = prepareTurnEffortConfiguration(session, { config: {} }, 'low');
  assert.equal(snapshot.effort, 'low');
  assert.equal(snapshot.initialEffort, 'low');
  assert.equal(session.effort, 'high');
  assert.equal(prepareTurnEffortConfiguration(session, { config: {} }).effort, 'high');
});

test('the step judge text keeps the request head, the round text and each call with its result ends', () => {
  const text = stepJudgeText({
    request: 'fix the failing test',
    step: 3,
    plan: 'Running the suite again.',
    calls: [
      { name: 'shell', args: '{"command":"npm test"}', result: `${'a'.repeat(600)}FAIL x.test.js` },
      { name: 'read', args: '{}', result: 'ok' },
      { name: 'grep', args: '{}', result: '' },
      { name: 'list', args: '{}', result: 'dropped' },
    ],
  });
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['step 3', 'request: fix the failing test', 'plan: Running the suite again.', 'call: shell {"command":"npm test"}']);
  assert.ok(lines[4].startsWith(`result: ${'a'.repeat(300)} … `) && lines[4].endsWith('FAIL x.test.js'));
  assert.equal(lines.length, 9, 'three calls at most');
  assert.equal(stepJudgeText({ request: '', step: 1, plan: '  ', calls: [] }), 'step 1\nrequest: ');
  // The stored result window is stable under re-windowing.
  const big = 'x'.repeat(5000);
  assert.equal(stepResultWindow(stepResultWindow(big)), stepResultWindow(big));
});

test('a step effort replaces the turn effort in the snapshot and projects after its tool batch', () => {
  const session = { provider: 'anthropic-oauth', model: 'claude-opus-5-5', effort: 'high', messages: [] };
  const turn = prepareTurnEffortConfiguration(session, { config: {} }, 'medium');
  assert.deepEqual(stepEffortConfiguration(turn, session.provider, session.model, 'low'), { ...turn, effort: 'low' });
  assert.equal(stepEffortConfiguration(turn, session.provider, session.model, 'bogus'), null);
  assert.equal(stepEffortConfiguration(null, session.provider, session.model, 'low'), null);
  const tool = { role: 'tool', toolCallId: 'c1', content: 'ok', meta: { effortConfiguration: { ...turn, effort: 'low' } } };
  const messages = [{ role: 'user', content: 'go', meta: { effortConfiguration: turn } }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] }, tool];
  const projection = projectEffortConfiguration(messages, session.provider, session.model, {});
  assert.equal(projection.updates.get(tool), 'low');
  assert.equal(projection.effort, 'low');
});

test('steps are judged by default on every route; the env turns them off', () => {
  const saved = process.env.MIXDOG_AUTO_EFFORT_STEPS;
  try {
    delete process.env.MIXDOG_AUTO_EFFORT_STEPS;
    assert.equal(autoEffortStepsEnabled(), true);
    process.env.MIXDOG_AUTO_EFFORT_STEPS = 'off';
    assert.equal(autoEffortStepsEnabled(), false);
  } finally {
    if (saved === undefined) delete process.env.MIXDOG_AUTO_EFFORT_STEPS;
    else process.env.MIXDOG_AUTO_EFFORT_STEPS = saved;
  }
});

test('step wiring is off without a step context and leaves the step unmarked when the judge is missing', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'mixdog-step-effort-'));
  const saved = { dir: process.env.MIXDOG_EFFORT_JUDGE_DIR, data: process.env.MIXDOG_DATA_DIR };
  t.after(() => {
    for (const [key, value] of [
      ['MIXDOG_EFFORT_JUDGE_DIR', saved.dir],
      ['MIXDOG_DATA_DIR', saved.data],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(data, { recursive: true, force: true });
  });
  process.env.MIXDOG_DATA_DIR = data;
  process.env.MIXDOG_EFFORT_JUDGE_DIR = join(data, 'no-model');
  const turn = { version: 1, provider: 'anthropic-oauth', model: 'claude-opus-5-5', mode: 'anthropic', initialEffort: 'medium', effort: 'medium' };
  const assistant = { role: 'assistant', content: 'Reading it.', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] };
  const tool = { role: 'tool', toolCallId: 'c1', content: 'text' };
  const state = (stepAutoEffort) => ({
    opts: { stepAutoEffort, effortConfiguration: turn },
    messages: [{ role: 'user', content: 'go' }, assistant, tool],
    model: 'claude-opus-5-5',
    sessionRef: { provider: 'anthropic-oauth' },
    sessionId: 's1',
  });

  const off = state(null);
  await markStepEffort(off, assistant);
  assert.equal(off.autoEffortSteps, undefined);

  const on = state({ request: 'go', base: 'medium' });
  await markStepEffort(on, assistant);
  await markStepEffort(on, assistant);
  assert.equal(on.autoEffortSteps, 2);
  assert.equal(tool.meta, undefined);
  const log = readFileSync(join(data, 'effort-judge', 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((entry) => [entry.atStep, entry.skipped]), [[1, 'model-missing'], [2, 'model-missing']]);
  assert.equal('request' in log[0], false);
});

test('turn wiring skips off mode, runtime turns, agent sessions, tagged prompts, cache-unsafe models and a missing model', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'mixdog-auto-effort-'));
  const saved = { mode: process.env.MIXDOG_AUTO_EFFORT, dir: process.env.MIXDOG_EFFORT_JUDGE_DIR, data: process.env.MIXDOG_DATA_DIR };
  t.after(() => {
    for (const [key, value] of [
      ['MIXDOG_AUTO_EFFORT', saved.mode],
      ['MIXDOG_EFFORT_JUDGE_DIR', saved.dir],
      ['MIXDOG_DATA_DIR', saved.data],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(data, { recursive: true, force: true });
  });
  process.env.MIXDOG_DATA_DIR = data;
  process.env.MIXDOG_EFFORT_JUDGE_DIR = join(data, 'no-model');
  const session = { provider: 'anthropic-oauth', model: 'claude-opus-5-5', effort: 'high', messages: [] };
  const provider = { config: {} };
  const ask = (input, s = session) => resolveTurnAutoEffort({ sessionId: 's1', session: s, provider, input });

  process.env.MIXDOG_AUTO_EFFORT = 'off';
  assert.equal(await ask({ prompt: 'fix the flaky test' }), null);

  process.env.MIXDOG_AUTO_EFFORT = 'on';
  assert.equal(await ask({ prompt: 'done', promptSource: { source: 'task-notification' } }), null);
  assert.equal(await ask({ prompt: '<skill>\n<name>x</name>\n</skill>' }), null);
  assert.equal(await ask({ prompt: 'hi' }, { ...session, model: 'claude-opus-4-5' }), null);
  assert.equal(
    await ask({ prompt: 'fix the flaky test', promptSource: { source: 'task-notification' } }, { ...session, owner: 'agent' }),
    null
  );
  assert.equal(await ask({ prompt: 'fix the flaky test' }), null);
  assert.equal(await ask({ prompt: 'fix the flaky test' }, { ...session, model: 'claude-sonnet-5-5' }), null);
  // An agent session's brief is judged (no model installed here: logged as skipped).
  assert.equal(await ask({ prompt: 'investigate the failing build' }, { ...session, owner: 'agent' }), null);

  const log = readFileSync(join(data, 'effort-judge', 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 3);
  assert.equal(log[2].skipped, 'model-missing');
  assert.equal(log[2].requestChars, 'investigate the failing build'.length);
  assert.equal(log[0].skipped, 'model-missing');
  assert.equal(log[0].base, 'medium');
  assert.equal(log[1].chosen, 'high');
  assert.equal(log[1].base, 'medium');
  assert.equal(log[0].requestChars, 'fix the flaky test'.length);
  assert.equal('request' in log[0], false);
});
