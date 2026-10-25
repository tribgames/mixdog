// The providers' cache-warm mode (anthropic-cache-warm.mjs) and its account
// gate (cache-warm-admission.mjs): one plain POST of the builder's body, no
// retry or fallback, skipped when the account holding the entry is cooling
// down, blocked, unknown or has no fresh quota reading, and its refusals
// reach the shared cooldown state.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-cache-warm-admission-'));
process.env.MIXDOG_DATA_DIR = dir;
const { registerProviderAccount, recordProviderAccountUsage, blockProviderAccount, newProviderAccountId } = await import(
  '../../../shared/provider-accounts.mjs'
);
const { _buildRequestBodyForCacheSmoke, AnthropicOAuthProvider } = await import('./anthropic-oauth.mjs');
const { providerAdmissionKey, providerAdmissionScheduler, resetProviderAdmissionCooldowns } = await import(
  './admission-scheduler.mjs'
);
const { cacheWarmAccountBlock } = await import('./cache-warm-admission.mjs');
const { cacheWarmSend } = await import('../session/cache-warm.mjs');

after(() => rmSync(dir, { recursive: true, force: true }));

const MODEL = 'claude-opus-4-7';
const TOOLS = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }];
const REQUEST = {
  provider: { name: 'anthropic-oauth' },
  model: MODEL,
  messages: [
    { role: 'system', content: 'You are the bot.' },
    { role: 'user', content: 'Check the feed.' },
  ],
  tools: TOOLS,
  opts: {
    session: { id: 'sess_home_lead', provider: 'anthropic-oauth', model: MODEL, messages: [] },
    cacheStrategy: { tools: 'none', system: '1h', tier3: '1h', messages: '1h' },
    effort: 'high',
  },
};

function sse(frames) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
    },
  });
  return new Response(body, { status: 200 });
}
const MESSAGE_START = {
  type: 'message_start',
  message: { usage: { input_tokens: 3, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 0, output_tokens: 1 } },
};
const CONTENT = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };

// Roster account ids by test name.
const ids = new Map();
const idOf = (name) => {
  if (!ids.has(name)) ids.set(name, newProviderAccountId());
  return ids.get(name);
};

async function account(name, usage = { quotaWindows: [{ label: '5H', usedPct: 10 }] }) {
  const id = idOf(name);
  await registerProviderAccount('anthropic-oauth', id);
  if (usage) await recordProviderAccountUsage('anthropic-oauth', id, usage);
  return id;
}

async function withFetch(handler, run) {
  const previousFetch = globalThis.fetch;
  const previousVersion = process.env.MIXDOG_CLI_VERSION;
  process.env.MIXDOG_CLI_VERSION = '9.9.9';
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    resetProviderAdmissionCooldowns('anthropic-oauth');
    globalThis.fetch = previousFetch;
    if (previousVersion === undefined) delete process.env.MIXDOG_CLI_VERSION;
    else process.env.MIXDOG_CLI_VERSION = previousVersion;
  }
}

function oauthProvider() {
  const oauth = new AnthropicOAuthProvider({});
  oauth.ensureAuth = async () => ({ accessToken: 'token' });
  return oauth;
}

test('OAuth warm mode: one plain POST of the builder’s body, no retry on 529, no fallback', async () => {
  await account('acct-warm');
  const oauth = oauthProvider();
  const send = cacheWarmSend(REQUEST);
  const posts = [];
  await withFetch(
    async (url, init) => {
      posts.push({ url: String(url), init });
      return posts.length === 1
        ? sse([MESSAGE_START, CONTENT])
        : new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 });
    },
    async () => {
      const usage = await oauth.sendCacheWarm(send.messages, send.model, send.tools, send.opts, {
        accountId: idOf('acct-warm'),
      });
      assert.equal(usage.cachedTokens, 70_000);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].init.headers['Content-Encoding'], undefined, 'plain body: no compression resend');
      const body = JSON.parse(posts[0].init.body);
      const expected = await _buildRequestBodyForCacheSmoke(send.messages, MODEL, TOOLS, send.opts);
      assert.deepEqual(body, JSON.parse(JSON.stringify(expected)), 'the provider’s own request body');
      assert.equal(body.max_tokens, 1);

      await assert.rejects(
        oauth.sendCacheWarm(send.messages, send.model, send.tools, { ...send.opts, fallbackModel: 'claude-sonnet-5-5' }, {
          accountId: idOf('acct-warm'),
        }),
        (error) => error.status === 529
      );
      assert.equal(posts.length, 2, 'no retry and no fallback-model re-send');
    }
  );
});

test('a warm’s 429 lands in the shared lane cooldown; the next warm is skipped before any POST', async () => {
  await account('acct-429');
  const oauth = oauthProvider();
  const send = cacheWarmSend(REQUEST);
  const posts = [];
  await withFetch(
    async (url, init) => {
      posts.push({ url: String(url), init });
      return new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
        status: 429,
        headers: { 'retry-after': '20' },
      });
    },
    async () => {
      await assert.rejects(
        oauth.sendCacheWarm(send.messages, send.model, send.tools, send.opts, { accountId: idOf('acct-429') }),
        (error) => error.status === 429
      );
      const key = providerAdmissionKey('anthropic-oauth', oauth);
      assert.equal(providerAdmissionScheduler.immediateBlock(key), 'rate-limit cooldown', 'normal sends see it');
      const before = posts.length;
      await assert.rejects(
        oauth.sendCacheWarm(send.messages, send.model, send.tools, send.opts, { accountId: idOf('acct-429') }),
        (error) => error.code === 'ECACHEWARMBLOCKED' && error.usage === null
      );
      assert.equal(posts.length, before, 'skipped, not retried');
    }
  );
});

test('a cooldown on the account instance’s lane (where its ordinary sends are admitted) blocks a warm before any POST', async () => {
  await account('acct-lane');
  const oauth = oauthProvider();
  const send = cacheWarmSend(REQUEST);
  const laneKey = providerAdmissionKey('anthropic-oauth', oauth);
  // Another account's lane cooling down does not block this one.
  const other = { name: 'anthropic-oauth', credentials: { accountId: 'other-account' } };
  const otherKey = providerAdmissionKey('anthropic-oauth', other);
  assert.notEqual(otherKey, laneKey);
  const posts = [];
  await withFetch(
    async (url, init) => {
      posts.push({ url: String(url), init });
      return sse([MESSAGE_START, CONTENT]);
    },
    async () => {
      const limited = () =>
        Object.assign(new Error('rate limited'), { status: 429, headers: new Headers({ 'retry-after': '20' }) });
      assert.equal(providerAdmissionScheduler.recordRateLimit(otherKey, limited()), true);
      const usage = await oauth.sendCacheWarm(send.messages, send.model, send.tools, send.opts, {
        accountId: idOf('acct-lane'),
      });
      assert.equal(usage.cachedTokens, 70_000, 'another account cooling down does not block');
      assert.equal(posts.length, 1);

      assert.equal(providerAdmissionScheduler.recordRateLimit(laneKey, limited()), true);
      await assert.rejects(
        oauth.sendCacheWarm(send.messages, send.model, send.tools, send.opts, { accountId: idOf('acct-lane') }),
        (error) => error.code === 'ECACHEWARMBLOCKED' && /cooldown/.test(error.message)
      );
      assert.equal(posts.length, 1, 'no POST while the instance lane cools down');
    }
  );
});

test('the account gate fails closed: unknown account, no fresh reading, a block or a full window skip', async () => {
  const instance = { name: 'anthropic-oauth', credentials: { accountId: 'gate' } };
  await account('acct-ok');
  assert.equal(cacheWarmAccountBlock('anthropic-oauth', instance, { accountId: idOf('acct-ok'), model: MODEL }), null);
  assert.match(cacheWarmAccountBlock('anthropic-oauth', instance, { model: MODEL }), /unknown/);
  assert.match(cacheWarmAccountBlock('anthropic-oauth', instance, { accountId: 'nobody', model: MODEL }), /not connected/);

  await account('acct-unmeasured', null);
  assert.match(
    cacheWarmAccountBlock('anthropic-oauth', instance, { accountId: idOf('acct-unmeasured'), model: MODEL }),
    /no fresh quota reading/
  );
  assert.match(
    cacheWarmAccountBlock('anthropic-oauth', instance, {
      accountId: idOf('acct-ok'),
      model: MODEL,
      now: Date.now() + 2 * 60 * 60_000,
    }),
    /no fresh quota reading/,
    'a reading older than the roster trusts'
  );

  await account('acct-full', { quotaWindows: [{ label: '5H', usedPct: 100, resetAt: Date.now() + 3_600_000 }] });
  assert.match(cacheWarmAccountBlock('anthropic-oauth', instance, { accountId: idOf('acct-full'), model: MODEL }), /exhausted/);

  await account('acct-blocked');
  await blockProviderAccount('anthropic-oauth', idOf('acct-blocked'), Date.now() + 600_000, '', 'retry-after');
  assert.match(cacheWarmAccountBlock('anthropic-oauth', instance, { accountId: idOf('acct-blocked'), model: MODEL }), /blocked/);
});
