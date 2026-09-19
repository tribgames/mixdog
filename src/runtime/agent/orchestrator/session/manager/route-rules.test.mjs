import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-route-rules-'));
  const previous = { MIXDOG_ROOT: process.env.MIXDOG_ROOT, MIXDOG_DATA_DIR: process.env.MIXDOG_DATA_DIR };
  process.env.MIXDOG_ROOT = join(root, 'plugin');
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const write = (relative, content) => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  // The isolated root has no lib/, so the production rules builder loads.
  const rules = await import('./rules-cache.mjs');
  return { write, rules };
}

test('a route round-reminder is resolved per provider/model and never enters the static rules', async (t) => {
  const { write, rules } = await fixture(t);
  write('plugin/rules/shared/00-general.md', '# General\n\n- Shared policy.');
  write(
    'plugin/rules/routes/gemini.md',
    '---\nmodels: gemini-*\nturn-reminder: GEMINI_TURN: plan it.\nround-reminder: GEMINI_REMINDER: batch it.\n---\n'
  );
  write(
    'plugin/rules/routes/fable.md',
    '---\nproviders: anthropic-oauth, anthropic\nmodels: claude-fable-5-1*, claude-fable-5.1*\nround-reminder: FABLE_REMINDER\n---\n- FABLE_STATIC_RULE'
  );
  assert.equal(
    rules._buildRouteRoundReminder({ provider: 'antigravity-oauth', model: 'gemini-3.8-flash' }),
    'GEMINI_REMINDER: batch it.'
  );
  assert.equal(
    rules._buildRouteTurnReminder({ provider: 'antigravity-oauth', model: 'gemini-3.8-flash' }),
    'GEMINI_TURN: plan it.'
  );
  assert.equal(
    rules._buildRouteRoundReminder({ provider: 'anthropic-oauth', model: 'claude-fable-5-1' }),
    'FABLE_REMINDER'
  );
  assert.equal(rules._buildRouteTurnReminder({ provider: 'anthropic-oauth', model: 'claude-fable-5-1' }), '');
  assert.equal(rules._buildRouteRoundReminder({ provider: 'anthropic-oauth', model: 'claude-opus-5-1' }), '');
  assert.equal(rules._buildRouteRoundReminder({ provider: 'grok-oauth', model: 'grok-4.6' }), '');
  // An unrestricted file is the base for every route; a file naming models or
  // providers adds to that line after it, never in place of it.
  write('plugin/rules/routes/common.md', '---\nturn-reminder: COMMON_TURN\nround-reminder: COMMON_ROUND\n---\n');
  assert.equal(rules._buildRouteRoundReminder({ provider: 'grok-oauth', model: 'grok-4.6' }), 'COMMON_ROUND');
  assert.equal(rules._buildRouteTurnReminder({ provider: 'openai-oauth', model: 'gpt-5.6-sol' }), 'COMMON_TURN');
  assert.equal(
    rules._buildRouteRoundReminder({ provider: 'anthropic-oauth', model: 'claude-fable-5-1' }),
    'COMMON_ROUND FABLE_REMINDER'
  );
  assert.equal(
    rules._buildRouteTurnReminder({ provider: 'anthropic-oauth', model: 'claude-fable-5-1' }),
    'COMMON_TURN'
  );
  assert.equal(
    rules._buildRouteRoundReminder({ provider: 'antigravity-oauth', model: 'gemini-3.8-flash' }),
    'COMMON_ROUND GEMINI_REMINDER: batch it.'
  );
  // The reminder-only file contributes nothing to BP1; the frontmatter keys never leak.
  assert.equal(rules._buildRouteRules({ provider: 'antigravity-oauth', model: 'gemini-3.8-flash' }), '');
  const fable = rules._buildRouteRules({ provider: 'anthropic-oauth', model: 'claude-fable-5-1' });
  assert.match(fable, /FABLE_STATIC_RULE/);
  assert.doesNotMatch(fable, /round-reminder|turn-reminder|FABLE_REMINDER/);
});

test('MIXDOG_TURN_REMINDER=0 drops the turn line and leaves the round line alone', async (t) => {
  const { write, rules } = await fixture(t);
  write('plugin/rules/routes/common.md', '---\nturn-reminder: COMMON_TURN\nround-reminder: COMMON_ROUND\n---\n');
  process.env.MIXDOG_TURN_REMINDER = '0';
  t.after(() => {
    delete process.env.MIXDOG_TURN_REMINDER;
  });
  assert.equal(rules._buildRouteTurnReminder({ provider: 'grok-oauth', model: 'grok-4.6' }), '');
  assert.equal(rules._buildRouteRoundReminder({ provider: 'grok-oauth', model: 'grok-4.6' }), 'COMMON_ROUND');
});

test('route rules bind to provider and model family through frontmatter', async (t) => {
  const { write, rules } = await fixture(t);
  write('plugin/rules/shared/00-general.md', '# General\n\n- Shared policy.');
  write(
    'plugin/rules/routes/gemini.md',
    '---\nmodels: gemini-*\n---\n# Parallel Function Calls\n\n- GEMINI_ROUTE_RULE\n<!-- tools: read -->\n- READ_ROUTE_RULE'
  );
  write(
    'plugin/rules/routes/antigravity.md',
    '---\nproviders: antigravity-oauth\nmodels: claude-*\n---\n- ANTIGRAVITY_CLAUDE_RULE'
  );
  write('plugin/rules/routes/everyone.md', '- EVERY_ROUTE_RULE');

  const gemini = rules._buildRouteRules({ provider: 'gemini', model: 'gemini-3.8-flash' });
  assert.match(gemini, /GEMINI_ROUTE_RULE/);
  assert.match(gemini, /READ_ROUTE_RULE/);
  assert.match(gemini, /EVERY_ROUTE_RULE/);
  assert.doesNotMatch(gemini, /ANTIGRAVITY_CLAUDE_RULE/);
  assert.doesNotMatch(gemini, /^---$|models:|<!--/m);
  // Gateway ids match on the `/`-leaf; the antigravity tier id matches the glob.
  assert.match(
    rules._buildRouteRules({ provider: 'openrouter', model: 'google/gemini-3.8-flash' }),
    /GEMINI_ROUTE_RULE/
  );
  assert.match(
    rules._buildRouteRules({ provider: 'antigravity-oauth', model: 'gemini-3.8-flash-high' }),
    /GEMINI_ROUTE_RULE/
  );
  // Tool markers gate route blocks exactly like shared blocks.
  assert.doesNotMatch(
    rules._buildRouteRules({ provider: 'gemini', model: 'gemini-3.8-flash', omitTools: ['read'] }),
    /READ_ROUTE_RULE/
  );
  // Both listed keys must match.
  assert.match(
    rules._buildRouteRules({ provider: 'antigravity-oauth', model: 'claude-opus-5' }),
    /ANTIGRAVITY_CLAUDE_RULE/
  );
  assert.doesNotMatch(
    rules._buildRouteRules({ provider: 'anthropic', model: 'claude-opus-5' }),
    /ANTIGRAVITY_CLAUDE_RULE/
  );
  assert.doesNotMatch(
    rules._buildRouteRules({ provider: 'antigravity-oauth', model: 'gemini-3.8-flash' }),
    /ANTIGRAVITY_CLAUDE_RULE/
  );
  assert.equal(rules._buildRouteRules({ provider: 'anthropic', model: 'claude-opus-5' }), '- EVERY_ROUTE_RULE');

  // BP1 = shared rules, one separator, then the matching route files in name order.
  const base = rules._buildBaseRules({ provider: 'gemini', model: 'gemini-3.8-flash' });
  assert.ok(base.startsWith('# General'));
  assert.ok(base.includes('\n\n---\n\n- EVERY_ROUTE_RULE\n# Parallel Function Calls\n'));
  assert.equal(
    rules._buildBaseRules({ provider: 'anthropic', model: 'claude-opus-5' }),
    `${rules._buildSharedRules()}\n\n---\n\n- EVERY_ROUTE_RULE`
  );
});

test('without a routes directory BP1 is exactly the shared rules', async (t) => {
  const { write, rules } = await fixture(t);
  write('plugin/rules/shared/00-general.md', '# General\n\n- Shared policy.');
  assert.equal(rules._buildRouteRules({ provider: 'gemini', model: 'gemini-3.8-flash' }), '');
  assert.equal(rules._buildBaseRules({ provider: 'gemini', model: 'gemini-3.8-flash' }), rules._buildSharedRules());
});
