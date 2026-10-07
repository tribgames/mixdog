import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_EFFORT_MIN_CONFIDENCE,
  autoEffortBase,
  autoEffortLadder,
  judgedStep,
  normalizeAutoEffortMode,
  resolveAutoEffort,
} from './auto-effort.mjs';
import { prepareTurnEffortConfiguration } from './effort-configuration.mjs';
import { builtinFeatureActive, INSTALLABLE_BUILTIN_IDS } from '../runtime-core/builtin-features.mjs';
import { resolveTurnAutoEffort } from '../session/manager/ask-turn-auto-effort.mjs';

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

test('an unsure judge keeps the default', () => {
  const flat = Array(4).fill(1 / 4);
  assert.ok(Math.max(...flat) < AUTO_EFFORT_MIN_CONFIDENCE);
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

test('the Auto effort built-in is active only when installed and enabled', () => {
  const saved = process.env.MIXDOG_FEATURE_AUTO_EFFORT;
  delete process.env.MIXDOG_FEATURE_AUTO_EFFORT;
  try {
    assert.ok(INSTALLABLE_BUILTIN_IDS.includes('autoEffort'));
    assert.equal(builtinFeatureActive({}, 'autoEffort'), false);
    assert.equal(builtinFeatureActive({ builtins: { autoEffort: { installed: true } } }, 'autoEffort'), true);
    assert.equal(
      builtinFeatureActive(
        { builtins: { autoEffort: { installed: true } }, modules: { autoEffort: { enabled: false } } },
        'autoEffort'
      ),
      false
    );
    assert.equal(builtinFeatureActive({ modules: { autoEffort: { enabled: true } } }, 'autoEffort'), false);
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
  assert.equal(await ask({ prompt: 'fix the flaky test' }, { ...session, owner: 'agent' }), null);
  assert.equal(await ask({ prompt: 'fix the flaky test' }), null);
  assert.equal(await ask({ prompt: 'fix the flaky test' }, { ...session, model: 'claude-sonnet-5-5' }), null);

  const log = readFileSync(join(data, 'effort-judge', 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 2);
  assert.equal(log[0].skipped, 'model-missing');
  assert.equal(log[0].base, 'medium');
  assert.equal(log[1].chosen, 'high');
  assert.equal(log[1].base, 'medium');
  assert.equal(log[0].requestChars, 'fix the flaky test'.length);
  assert.equal('request' in log[0], false);
});
