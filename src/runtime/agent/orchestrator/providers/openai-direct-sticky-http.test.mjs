import '../../../shared/llm/usage-test-support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger } from '../../../shared/llm/usage-ledger.mjs';
import { accountProviderSend } from '../../../shared/llm/usage-accounting.mjs';
import { OpenAIDirectProvider } from './openai-ws.mjs';

const RESULT = { content: 'ok', toolCalls: [], usage: null };

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function setup() {
  const provider = new OpenAIDirectProvider({ apiKey: 'old-key' });
  provider._httpFallbackPoolKeys.add('sess');
  let reloads = 0;
  provider.reloadApiKey = () => {
    reloads += 1;
    return 'fresh-key';
  };
  return { provider, reloads: () => reloads };
}

const messages = [{ role: 'user', content: 'hi' }];

test('sticky HTTP session: 401 reloads the key and retries once over HTTP', async () => {
  const { provider, reloads } = setup();
  const httpKeys = [];
  let wsCalls = 0;
  const result = await withEnv({ MIXDOG_OAI_TRANSPORT: undefined, MIXDOG_OPENAI_HTTP_FALLBACK: undefined }, () =>
    provider.send(messages, 'gpt-5.5', [], {
      sessionId: 'sess',
      _sendViaWebSocketFn: async () => {
        wsCalls += 1;
        return RESULT;
      },
      _sendViaHttpSseFn: async ({ auth }) => {
        httpKeys.push(auth.apiKey);
        if (auth.apiKey === 'old-key') throw Object.assign(new Error('unauthorized'), { httpStatus: 401 });
        return RESULT;
      },
    })
  );
  assert.equal(result, RESULT);
  assert.equal(wsCalls, 0);
  assert.equal(reloads(), 1);
  assert.deepEqual(httpKeys, ['old-key', 'fresh-key']);
});

test('HTTP 401 replay keeps the failed attempt usage billed', async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-sticky-usage-')), 'ledger.sqlite');
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
  const { provider } = setup();
  const usage = (inputTokens) => ({ inputTokens, outputTokens: 0, cachedTokens: 0 });
  await withEnv({ MIXDOG_OAI_TRANSPORT: 'http-sse' }, () =>
    accountProviderSend(
      'openai',
      {},
      () =>
        provider.send(messages, 'gpt-5.5', [], {
          sessionId: 'billing',
          _sendViaHttpSseFn: async ({ auth }) => {
            if (auth.apiKey === 'old-key') {
              throw Object.assign(new Error('unauthorized'), {
                httpStatus: 401,
                partialUsage: usage(100),
                partialModel: 'gpt-5.5',
              });
            }
            return { ...RESULT, usage: usage(200) };
          },
        }),
      'gpt-5.5',
      { sessionId: 'billing' }
    )
  );
  const ledger = new UsageLedger(path);
  try {
    const rows = ledger.db.prepare('SELECT * FROM events').all();
    assert.equal(
      rows.reduce((total, row) => total + row.input, 0),
      300
    );
  } finally {
    ledger.close();
  }
});

test('sticky HTTP session: unsafeToRetry 401 is rethrown without reload', async () => {
  const { provider, reloads } = setup();
  let httpCalls = 0;
  await assert.rejects(
    withEnv({ MIXDOG_OAI_TRANSPORT: undefined, MIXDOG_OPENAI_HTTP_FALLBACK: undefined }, () =>
      provider.send(messages, 'gpt-5.5', [], {
        sessionId: 'sess',
        _sendViaHttpSseFn: async () => {
          httpCalls += 1;
          throw Object.assign(new Error('unauthorized'), { httpStatus: 401, liveTextEmitted: true });
        },
      })
    ),
    /unauthorized/
  );
  assert.equal(httpCalls, 1);
  assert.equal(reloads(), 0);
});

test('forced http-sse transport: 401 reloads the key and retries once', async () => {
  const { provider, reloads } = setup();
  const httpKeys = [];
  await withEnv({ MIXDOG_OAI_TRANSPORT: 'http-sse' }, () =>
    provider.send(messages, 'gpt-5.5', [], {
      sessionId: 'other',
      _sendViaHttpSseFn: async ({ auth }) => {
        httpKeys.push(auth.apiKey);
        if (auth.apiKey === 'old-key') throw Object.assign(new Error('unauthorized'), { httpStatus: 401 });
        return RESULT;
      },
    })
  );
  assert.equal(reloads(), 1);
  assert.deepEqual(httpKeys, ['old-key', 'fresh-key']);
});

test('sticky set is ignored under ws-delta policy: send uses WS', async () => {
  const { provider } = setup();
  let wsCalls = 0;
  let httpCalls = 0;
  await withEnv({ MIXDOG_OAI_TRANSPORT: 'ws-delta' }, () =>
    provider.send(messages, 'gpt-5.5', [], {
      sessionId: 'sess',
      _sendViaWebSocketFn: async () => {
        wsCalls += 1;
        return RESULT;
      },
      _sendViaHttpSseFn: async () => {
        httpCalls += 1;
        return RESULT;
      },
    })
  );
  assert.equal(wsCalls, 1);
  assert.equal(httpCalls, 0);
});

test('sticky set is ignored when MIXDOG_OPENAI_HTTP_FALLBACK=0: send uses WS', async () => {
  const { provider } = setup();
  let wsCalls = 0;
  await withEnv({ MIXDOG_OAI_TRANSPORT: undefined, MIXDOG_OPENAI_HTTP_FALLBACK: '0' }, () =>
    provider.send(messages, 'gpt-5.5', [], {
      sessionId: 'sess',
      _sendViaWebSocketFn: async () => {
        wsCalls += 1;
        return RESULT;
      },
      _sendViaHttpSseFn: async () => assert.fail('must not use HTTP'),
    })
  );
  assert.equal(wsCalls, 1);
});
