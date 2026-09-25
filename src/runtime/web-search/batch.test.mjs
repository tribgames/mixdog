import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import Ajv from 'ajv';
import { TOOL_DEFS } from './tool-defs.mjs';
import { toGeminiTools } from '../agent/orchestrator/providers/gemini-schema.mjs';

const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-web-batch-test-'));
const { handleToolCall, stop } = await import('./index.mjs');
after(async () => {
  await stop();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
});
const text = (result) =>
  result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
const success = (query) => ({
  answer: `Answer for ${query}`,
  citations: [{ url: `https://example.invalid/${encodeURIComponent(query)}`, title: query }],
});
function gate() {
  let release;
  return {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
    release,
  };
}

test('web query schema and Gemini wire reject inputs the runtime cannot search', async () => {
  const tool = TOOL_DEFS.find((tool) => tool.name === 'web_search');
  const original = structuredClone(tool);
  const wire = toGeminiTools([tool]).functionDeclarations[0];
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validators = [ajv.compile(tool.inputSchema), ajv.compile(wire.parametersJsonSchema || wire.parameters)];
  for (const query of [undefined, '', ' \t\n', [], ['valid', ''], ['valid', ' '], ['valid', 7]]) {
    const args = query === undefined ? {} : { query };
    for (const validate of validators) assert.equal(validate(args), false, JSON.stringify(args));
    const result = await handleToolCall('web_search', args, {
      nativeWebSearch: async () => assert.fail('invalid queries must not reach the provider'),
    });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  for (const query of ['valid', ' 유효한 검색 ', ['one', 'two']]) {
    for (const validate of validators) assert.equal(validate({ query }), true, JSON.stringify(query));
  }
  assert.deepEqual(tool, original);
});

test('web_fetch rejects an empty URL array in the schema, wire and runtime', async () => {
  const tool = TOOL_DEFS.find((tool) => tool.name === 'web_fetch');
  const wire = toGeminiTools([tool]).functionDeclarations[0];
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const schema of [tool.inputSchema, wire.parametersJsonSchema || wire.parameters]) {
    const validate = ajv.compile(schema);
    assert.equal(validate({ url: [] }), false);
    assert.equal(validate({ url: ['https://example.invalid'] }), true);
  }
  const result = await handleToolCall('web_fetch', { url: [] });
  assert.equal(result.isError, true);
});

test('web array searches overlap, preserve filters and return in input order', async () => {
  const hold = gate();
  const started = [];
  const args = { query: ['slow-query', 'fast-query'], site: 'example.invalid', type: 'news', maxResults: 3 };
  const original = structuredClone(args);
  const pending = handleToolCall('web_search', args, {
    nativeWebSearch: async (input) => {
      started.push(input);
      if (input.keywords === 'slow-query') await hold.promise;
      return success(input.keywords);
    },
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      started.map((row) => row.keywords),
      args.query
    );
    for (const row of started) {
      assert.equal(row.site, args.site);
      assert.equal(row.type, args.type);
      assert.equal(row.maxResults, args.maxResults);
    }
  } finally {
    hold.release();
  }
  const result = await pending;
  assert.notEqual(result.isError, true);
  assert.ok(text(result).indexOf('Answer for slow-query') < text(result).indexOf('Answer for fast-query'));
  assert.match(text(result), /Answer for fast-query/);
  assert.deepEqual(args, original);
});

test('scalar provider failures remain tool errors', async () => {
  const result = await handleToolCall(
    'web_search',
    { query: 'scalar-error' },
    {
      nativeWebSearch: async () => {
        throw new Error('scalar provider failure');
      },
    }
  );
  assert.equal(result.isError, true);
  assert.match(text(result), /scalar provider failure/);
});

test('all failed queries retain the error flag and each failure', async () => {
  const calls = [];
  const result = await handleToolCall(
    'web_search',
    { query: ['failed-one', 'failed-two'] },
    {
      nativeWebSearch: async ({ keywords }) => {
        calls.push(keywords);
        throw new Error(`Failure for ${keywords}`);
      },
    }
  );
  assert.equal(result.isError, true);
  assert.match(text(result), /2\/2 queries failed/);
  assert.match(text(result), /Failure for failed-one/);
  assert.match(text(result), /Failure for failed-two/);
  assert.deepEqual(calls, ['failed-one', 'failed-two'], 'No hidden retry');
});

test('partial failures flag the incomplete batch without discarding successful answers', async () => {
  const calls = [];
  const result = await handleToolCall(
    'web_search',
    { query: ['partial-ok', 'partial-error'] },
    {
      nativeWebSearch: async ({ keywords }) => {
        calls.push(keywords);
        if (keywords === 'partial-error') throw new Error('partial provider failure');
        return success(keywords);
      },
    }
  );
  assert.equal(result.isError, true);
  assert.match(text(result), /1\/2 queries failed; successful results are retained/);
  assert.match(text(result), /Answer for partial-ok/);
  assert.match(text(result), /partial provider failure/);
  assert.deepEqual(calls, ['partial-ok', 'partial-error']);
});

test('duplicate trimmed queries execute once without mutating the request', async () => {
  const args = { query: [' duplicate ', 'duplicate'] };
  const original = structuredClone(args);
  const calls = [];
  const result = await handleToolCall('web_search', args, {
    nativeWebSearch: async ({ keywords }) => {
      calls.push(keywords);
      return success(keywords);
    },
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, ['duplicate']);
  assert.deepEqual(args, original);
});

test('an aborted batch stays failed and never starts provider work', async () => {
  const controller = new AbortController();
  controller.abort(new Error('audit cancellation'));
  const result = await handleToolCall(
    'web_search',
    { query: ['cancel-one', 'cancel-two'] },
    {
      signal: controller.signal,
      nativeWebSearch: async () => assert.fail('Cancelled work must not start'),
    }
  );
  assert.equal(result.isError, true);
  assert.match(text(result), /2\/2 queries failed/);
  assert.match(text(result), /audit cancellation/);
});

const within = (promise, ms = 1000) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms))]);

test('a cancelled search stops its provider work and returns without waiting for it', async () => {
  const controller = new AbortController();
  let providerSignal;
  const pending = handleToolCall(
    'web_search',
    { query: 'cancel-mid-flight' },
    {
      signal: controller.signal,
      nativeWebSearch: ({ signal }) =>
        new Promise((_resolve, reject) => {
          providerSignal = signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('user cancelled'));
  const result = await within(pending);
  assert.notEqual(result, 'still waiting');
  assert.equal(result.isError, true);
  assert.match(text(result), /user cancelled/);
  assert.equal(providerSignal?.aborted, true);
});

test('one caller leaving a shared search does not cancel it for the others', async () => {
  const first = new AbortController();
  const hold = gate();
  let providerSignal;
  let calls = 0;
  const nativeWebSearch = ({ keywords, signal }) => {
    calls += 1;
    providerSignal = signal;
    return hold.promise.then(() => success(keywords));
  };
  const leaving = handleToolCall('web_search', { query: 'shared-leave' }, { signal: first.signal, nativeWebSearch });
  const staying = handleToolCall('web_search', { query: 'shared-leave' }, { nativeWebSearch });
  await new Promise((resolve) => setImmediate(resolve));
  first.abort(new Error('first caller left'));
  const left = await within(leaving);
  hold.release();
  assert.notEqual(left, 'still waiting');
  assert.equal(left.isError, true);
  const kept = await staying;
  assert.notEqual(kept.isError, true);
  assert.match(text(kept), /Answer for shared-leave/);
  assert.equal(calls, 1);
  assert.equal(providerSignal.aborted, false);
});

test('local and image fetch reject oversized batches, invalid arguments and blocked targets as tool errors', async () => {
  const urls = Array.from({ length: 9 }, (_, index) => `http://127.0.0.1/${index}`);
  for (const name of ['local_fetch', 'image_fetch']) {
    const oversized = await handleToolCall(name, { url: urls });
    assert.deepEqual(oversized, {
      content: [{ type: 'text', text: 'Error: fetch batch exceeds maximum of 8 URLs.' }],
      isError: true,
    });
    const invalid = await handleToolCall(name, { url: 'not a url' });
    assert.equal(invalid.isError, true);
    assert.equal(JSON.parse(text(invalid)).error, 'Invalid arguments');
  }
  const blocked = await handleToolCall('local_fetch', { url: 'http://example.invalid/' });
  assert.equal(blocked.isError, true);
  assert.match(text(blocked), /^Fetch failed: .*non-loopback/);
});
