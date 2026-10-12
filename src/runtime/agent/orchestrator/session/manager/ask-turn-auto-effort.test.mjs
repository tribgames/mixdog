import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveTurnAutoEffort } from './ask-turn-auto-effort.mjs';

const ENV_KEYS = ['MIXDOG_AUTO_EFFORT', 'MIXDOG_EFFORT_JUDGE_DIR', 'MIXDOG_EFFORT_DECISIONS_LOG'];

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
    assert.equal(await resolveTurnAutoEffort({ sessionId: 'off', session: session({ autoEffort: false }), input }), null);
    assert.equal(judged('off'), false, 'the off route never reaches the judge');
    await resolveTurnAutoEffort({ sessionId: 'absent', session: session({}), input });
    assert.equal(judged('absent'), true, 'an absent flag keeps auto effort on');
    await resolveTurnAutoEffort({ sessionId: 'on', session: session({ autoEffort: true }), input });
    assert.equal(judged('on'), true);
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
