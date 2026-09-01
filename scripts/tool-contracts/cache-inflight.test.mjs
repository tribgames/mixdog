// Builtin result-cache single-flight layers and provider cache strategy.
import './_env.mjs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert } from './_helpers.mjs';
import {
  invalidateBuiltinResultCache,
  runRawContentInFlight,
  runReadOnlyStatInFlight,
  runResultCacheInFlight,
} from '../../src/runtime/agent/orchestrator/tools/builtin/cache-layers.mjs';
import {
  cacheCapabilityForProvider,
  resolveCacheStrategy,
  shouldMarkWarmForProvider,
  shouldRecordObservedForProvider,
} from '../../src/runtime/agent/orchestrator/agent-runtime/cache-strategy.mjs';

test('in-flight result cache computes once and shares the result', async () => {
  let computes = 0;
  const key = `tool-contracts-inflight-${Date.now()}-${Math.random()}`;
  const [a, b] = await Promise.all([
    runResultCacheInFlight(key, async () => {
      computes += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return 'shared-result';
    }),
    runResultCacheInFlight(key, async () => {
      computes += 1;
      return 'duplicate-result';
    }),
  ]);
  assert(computes === 1, `in-flight result cache should compute once, computed ${computes}`);
  assert(a === 'shared-result' && b === 'shared-result', 'in-flight result cache should share the first result');
});

test('one subscriber abort must not cancel another subscriber', async () => {
  const key = `tool-contracts-inflight-subscriber-abort-${Date.now()}-${Math.random()}`;
  const first = new AbortController();
  const second = new AbortController();
  let computeAborted = false;
  const compute = ({ signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('survived-first-subscriber-abort'), 20);
    signal.addEventListener('abort', () => {
      computeAborted = true;
      clearTimeout(timer);
      reject(new Error('shared compute aborted'));
    }, { once: true });
  });
  const a = runResultCacheInFlight(key, compute, { signal: first.signal, scopes: ['/scope/a'] });
  const b = runResultCacheInFlight(key, compute, { signal: second.signal, scopes: ['/scope/a'] });
  first.abort();
  let firstError = null;
  try { await a; } catch (error) { firstError = error; }
  assert(/operation aborted/.test(String(firstError?.message || '')), 'aborted subscriber should reject');
  assert(await b === 'survived-first-subscriber-abort', 'remaining subscriber should keep shared compute alive');
  assert(!computeAborted, 'one subscriber abort must not cancel another subscriber');
});

test('unrelated invalidation preserves in-flight scoped computes', async () => {
  const key = `tool-contracts-inflight-scope-${Date.now()}-${Math.random()}`;
  let resolveCompute;
  let computeAborted = false;
  const compute = ({ signal }) => new Promise((resolve, reject) => {
    resolveCompute = resolve;
    signal.addEventListener('abort', () => {
      computeAborted = true;
      reject(new Error('scoped compute aborted'));
    }, { once: true });
  });
  const pending = runResultCacheInFlight(key, compute, { scopes: ['/scope/kept'] });
  await new Promise((resolve) => setImmediate(resolve));
  invalidateBuiltinResultCache(['/scope/unrelated']);
  resolveCompute('scope-survived');
  assert(await pending === 'scope-survived', 'unrelated invalidation must not abort in-flight compute');
  assert(!computeAborted, 'unrelated invalidation must preserve in-flight scope');
});

test('cross-call stat single-flight computes once', async () => {
  const virtualPath = join(tmpdir(), `tool-contracts-stat-inflight-${process.pid}-${Date.now()}`);
  let computes = 0;
  const values = await Promise.all(Array.from({ length: 8 }, () => runReadOnlyStatInFlight(
    virtualPath,
    async () => {
      computes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { size: 7 };
    },
  )));
  assert(computes === 1, `cross-call stat single-flight should compute once, computed ${computes}`);
  assert(values.every((value) => value.size === 7), 'cross-call stat single-flight should share the result');
});

test('cross-call read single-flight shares bytes until invalidated', async () => {
  const virtualPath = join(tmpdir(), `tool-contracts-read-inflight-${process.pid}-${Date.now()}`);
  let computes = 0;
  const values = await Promise.all(Array.from({ length: 8 }, () => runRawContentInFlight(
    virtualPath,
    async () => {
      computes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Buffer.from('shared-read');
    },
  )));
  assert(computes === 1, `cross-call read single-flight should compute once, computed ${computes}`);
  assert(values.every((value) => value.toString() === 'shared-read'), 'cross-call read single-flight should share bytes');
  invalidateBuiltinResultCache([virtualPath]);
  await runRawContentInFlight(virtualPath, async () => {
    computes += 1;
    return Buffer.from('fresh-read');
  });
  assert(computes === 2, 'path invalidation should start a fresh read generation');
});

test('provider cache strategy tiers and capabilities stay stable', () => {
  const publicStrategy = resolveCacheStrategy('worker');
  assert(publicStrategy.tools === 'none', `Anthropic tools must not spend a cache_control BP: ${JSON.stringify(publicStrategy)}`);
  // BP1~3 and the volatile message tail stay 1h; see resolveCacheStrategy.
  assert(publicStrategy.system === '1h' && publicStrategy.tier3 === '1h' && publicStrategy.messages === '1h', `public cache tiers changed unexpectedly: ${JSON.stringify(publicStrategy)}`);
  assert(cacheCapabilityForProvider('anthropic-oauth') === 'explicit-breakpoint', 'Anthropic OAuth should remain explicit-breakpoint');
  assert(cacheCapabilityForProvider('openai-oauth') === 'key-prefix', 'OpenAI OAuth should remain key-prefix');
  assert(cacheCapabilityForProvider('xai') === 'key-prefix', 'xAI should remain key-prefix');
  assert(cacheCapabilityForProvider('grok-oauth') === 'key-prefix', 'Grok OAuth should remain key-prefix');
  assert(cacheCapabilityForProvider('gemini') === 'managed-explicit', 'Gemini should be provider-managed explicit cachedContents');
  assert(shouldMarkWarmForProvider('gemini') === true, 'Gemini provider-managed cache should count as warmable');
  assert(shouldRecordObservedForProvider('gemini') === false, 'Gemini is no longer implicit-observed only');
  assert(shouldRecordObservedForProvider('deepseek') === true, 'DeepSeek should remain observed-only');
});
