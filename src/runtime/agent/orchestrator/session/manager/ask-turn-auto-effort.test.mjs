import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prewarmSessionAutoEffort, resolveTurnAutoEffort } from './ask-turn-auto-effort.mjs';

const ENV_KEYS = ['MIXDOG_AUTO_EFFORT', 'MIXDOG_EFFORT_JUDGE_DIR', 'MIXDOG_EFFORT_DECISIONS_LOG'];

test('session pre-warm starts the judge only when Auto effort is on and the route can be judged', async (t) => {
  const original = await import('../../../../effort-judge/judge-client.mjs');
  let starts = 0;
  t.mock.module('../../../../effort-judge/judge-client.mjs', {
    namedExports: {
      ...original,
      prewarmEffortJudge: () => {
        starts += 1;
        return true;
      },
    },
  });
  const saved = process.env.MIXDOG_AUTO_EFFORT;
  t.after(() => {
    if (saved === undefined) delete process.env.MIXDOG_AUTO_EFFORT;
    else process.env.MIXDOG_AUTO_EFFORT = saved;
  });
  const { prewarmSessionAutoEffort: prewarm } = await import(`./ask-turn-auto-effort.mjs?prewarm=${Date.now()}`);
  const opus = { provider: 'anthropic-oauth', model: 'claude-opus-5-5' };
  const provider = { name: 'anthropic-oauth' };

  process.env.MIXDOG_AUTO_EFFORT = 'off';
  assert.equal(prewarm(opus, provider), false);
  assert.equal(starts, 0, 'Auto effort off starts nothing');

  process.env.MIXDOG_AUTO_EFFORT = 'on';
  assert.equal(prewarm({ ...opus, autoEffort: false }, provider), false);
  assert.equal(prewarm({ provider: 'anthropic-oauth', model: 'claude-3-5-haiku' }, provider), false);
  assert.equal(starts, 0, 'a route that turned it off, or one whose effort cannot change, starts nothing');

  assert.equal(prewarm(opus, provider), true);
  assert.equal(starts, 1);
  assert.equal(prewarm(null, null), false, 'a malformed session never throws');
});

test('session pre-warm spawns no worker when the model is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-prewarm-missing-'));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.MIXDOG_AUTO_EFFORT = 'on';
  process.env.MIXDOG_EFFORT_JUDGE_DIR = root;
  try {
    assert.equal(
      prewarmSessionAutoEffort({ provider: 'anthropic-oauth', model: 'claude-opus-5-5' }, { name: 'anthropic-oauth' }),
      false
    );
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('the judged base is the Auto reasoning base setting, clamped to the model ladder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-auto-effort-base-'));
  const keys = [...ENV_KEYS, 'MIXDOG_DATA_DIR', 'MIXDOG_USER_DATA_BACKUP_ROOT'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const log = join(root, 'decisions.jsonl');
  process.env.MIXDOG_AUTO_EFFORT = 'on';
  process.env.MIXDOG_EFFORT_JUDGE_DIR = root;
  process.env.MIXDOG_EFFORT_DECISIONS_LOG = log;
  process.env.MIXDOG_DATA_DIR = root;
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(root, 'backups');
  const baseOf = async (sessionId, effort) => {
    await resolveTurnAutoEffort({
      sessionId,
      session: { provider: 'anthropic-oauth', model: 'claude-opus-5-5', effort, messages: [] },
      input: { prompt: 'fix the failing test' },
    });
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((row) => row.sessionId === sessionId).base;
  };
  try {
    assert.equal(await baseOf('default', 'low'), 'medium', 'absent setting is medium');
    writeFileSync(join(root, 'mixdog-config.json'), JSON.stringify({ agent: { autoEffortBase: 'high' } }));
    assert.equal(await baseOf('high-low', 'low'), 'high');
    assert.equal(await baseOf('high-max', 'max'), 'high', 'the chosen effort does not decide the base');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session whose route turned Auto effort off is never judged; an absent flag still is', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-auto-effort-route-'));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const log = join(root, 'decisions.jsonl');
  process.env.MIXDOG_AUTO_EFFORT = 'on';
  // An empty judge directory: the judge answers "skipped" at once, and every
  // judged turn still records its decision in the log.
  process.env.MIXDOG_EFFORT_JUDGE_DIR = root;
  process.env.MIXDOG_EFFORT_DECISIONS_LOG = log;
  const session = (extra) => ({
    provider: 'anthropic-oauth',
    model: 'claude-opus-5-5',
    effort: 'high',
    messages: [],
    ...extra,
  });
  const judged = (sessionId) =>
    existsSync(log) &&
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .some((line) => JSON.parse(line).sessionId === sessionId);
  const input = { prompt: 'fix the failing test' };
  try {
    assert.equal(
      await resolveTurnAutoEffort({ sessionId: 'off', session: session({ autoEffort: false }), input }),
      null
    );
    assert.equal(judged('off'), false, 'the off route never reaches the judge');
    await resolveTurnAutoEffort({ sessionId: 'absent', session: session({}), input });
    assert.equal(judged('absent'), true, 'an absent flag keeps auto effort on');
    await resolveTurnAutoEffort({ sessionId: 'on', session: session({ autoEffort: true }), input });
    assert.equal(judged('on'), true);
    // An Anthropic Opus route is eligible: the skip comes from the empty judge, not the ladder.
    const rows = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.notEqual(rows.find((row) => row.sessionId === 'on').skipped, 'default-outside-auto-range');
    // The base is the setting (default medium), not the chosen effort: a saved
    // max no longer takes the route off the ladder, so it is judged like any other.
    assert.equal(await resolveTurnAutoEffort({ sessionId: 'max', session: session({ effort: 'max' }), input }), null);
    const max = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((row) => row.sessionId === 'max');
    assert.equal(max.chosen, 'max');
    assert.equal(max.base, 'medium');
    assert.notEqual(max.skipped, 'default-outside-auto-range');
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
