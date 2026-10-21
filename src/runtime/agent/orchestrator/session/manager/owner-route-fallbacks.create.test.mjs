// The real create path and a real ask-loop turn for Lead-class sessions: the
// coding Lead takes the Lead preset's fallbacks, a bot's home chat its own
// route's; a 429 on the first model lands the turn on the fallback with the
// switch notice. Fake providers, real createSession / askSession.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-owner-create-'));
const dataDir = join(root, 'data');
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(join(dataDir, 'bots', 'sample'), { recursive: true });
const FALLBACK = { provider: 'fb-second', model: 'm-second' };
writeFileSync(
  join(dataDir, 'mixdog-config.json'),
  JSON.stringify({
    agent: {
      default: 'workflow-lead',
      presets: [
        {
          id: 'workflow-lead',
          name: 'WORKFLOW LEAD',
          type: 'agent',
          tools: 'full',
          provider: 'fb-first',
          model: 'm-first',
          fallbacks: [FALLBACK],
        },
      ],
    },
  })
);
writeFileSync(join(dataDir, 'bots', 'migration.json'), JSON.stringify({ version: 1, bots: ['sample'] }));
writeFileSync(
  join(dataDir, 'bots', 'sample', 'agent.json'),
  JSON.stringify({ name: 'Sample', route: { provider: 'fb-first', model: 'm-first', fallbacks: [FALLBACK] } })
);
writeFileSync(join(dataDir, 'bots', 'sample', 'AGENT.md'), '---\nname: Sample\nkind: bot\n---\n# Sample\n\nROLE');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { invalidateConfigReadCache } = await import('../../../../shared/config.mjs');
invalidateConfigReadCache();
const { registerBotRouteStore } = await import('../../../../shared/agent-store.mjs');
registerBotRouteStore(() => dataDir);
// A fallback hop re-inits providers from the config; the fake providers are registered by hand.
const realRegistry = await import('../../providers/registry.mjs');
mock.module('../../providers/registry.mjs', {
  namedExports: { ...realRegistry, initProviders: async () => {} },
});
const { createSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { deleteSession, loadSession } = await import('../store.mjs');
const { _withRegisteredProviderForTestAsync } = realRegistry;

async function withProviders(sends, run) {
  const first = {
    name: 'fb-first',
    contextWindow: 128000,
    async send() {
      sends.push('fb-first');
      throw Object.assign(new Error('usage limit reached'), { status: 429 });
    },
  };
  const second = {
    name: 'fb-second',
    contextWindow: 128000,
    async send(_messages, model) {
      sends.push(`fb-second/${model}`);
      return { content: 'from the fallback', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  await _withRegisteredProviderForTestAsync('fb-first', first, () =>
    _withRegisteredProviderForTestAsync('fb-second', second, run)
  );
}

const create = (extra = {}) =>
  createSession({
    provider: 'fb-first',
    model: 'm-first',
    cwd: root,
    skipSkills: true,
    owner: 'cli',
    agent: 'lead',
    ...extra,
  });

test('createSession: a coding Lead gets the Lead preset chain, a bot home chat its own, other models none', async (t) => {
  await withProviders([], async () => {
    const lead = create();
    const bot = create({ id: 'sess_home_sample', owner: 'cli', agent: 'sample' });
    const picked = create({ model: 'other-model' });
    t.after(() => {
      for (const s of [lead, bot, picked]) deleteSession(s.id, { deferSummaryUpdate: true });
    });
    assert.equal(lead.sessionMode, 'coding');
    assert.deepEqual(lead.routeFallbacks, [FALLBACK]);
    assert.equal(bot.sessionMode, 'agent');
    assert.deepEqual(bot.routeFallbacks, [FALLBACK]);
    assert.equal(picked.routeFallbacks, undefined, 'a model picked for this session has no chain');
  });
});

for (const [name, extra] of [
  ['coding Lead', {}],
  ['bot home chat', { id: 'sess_home_sample', owner: 'cli', agent: 'sample' }],
]) {
  test(`${name}: a 429 on the first model lands the turn on the fallback with the switch notice`, async (t) => {
    const sends = [];
    await withProviders(sends, async () => {
      const session = create(extra);
      t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
      const notices = [];
      const result = await askSession(session.id, 'hello', null, null, null, null, {
        onStageChange: (stage, detail) => {
          if (stage === 'notice') notices.push(detail.message);
        },
      });
      assert.equal(result.content, 'from the fallback');
      assert.deepEqual(sends, ['fb-first', 'fb-second/m-second']);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /switched to/);
      const stored = loadSession(session.id);
      assert.equal(stored.provider, 'fb-second');
      assert.equal(stored.routeFallbackIndex, 1);
    });
  });
}

test('no fallbacks: the same 429 surfaces unchanged', async (t) => {
  const sends = [];
  await withProviders(sends, async () => {
    const session = create({ model: 'other-model' });
    t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
    await assert.rejects(askSession(session.id, 'hello', null, null, null, null, {}), /usage limit reached/);
    assert.deepEqual(sends, ['fb-first']);
  });
});
