import assert from 'node:assert/strict';
import test from 'node:test';
import { _runIdleReclaimForTest } from './idle-reclaim.ts';

import {
  fetchSessionDiff,
  fetchSessionDiffFilePatch,
  fetchSessionDiffFilePatchResult,
  peekSessionDiff,
  primeSessionDiff,
  releaseSessionDiff,
  answerSessionDiffSignal,
  answeredSessionDiffSignal,
  sessionDiffRevision,
  sameSessionDiff,
  SESSION_DIFF_CACHE_MAX_CHARS,
} from './session-diff-cache.ts';

const PATCH = [
  'diff --git a/src/owned.ts b/src/owned.ts',
  '--- a/src/owned.ts',
  '+++ b/src/owned.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

const RESULT = {
  supported: true,
  files: [{ path: 'src/owned.ts', status: 'M', additions: 1, deletions: 1 }],
  patch: PATCH,
};

function stubBackend(calls) {
  globalThis.window = {
    mixdogDesktop: {
      invokeCapability: async ({ sessionId }) => {
        calls.push(sessionId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { value: { ...RESULT } };
      },
    },
  };
}

test('concurrent callers share one backend round-trip', async () => {
  const calls = [];
  stubBackend(calls);
  const [first, second] = await Promise.all([fetchSessionDiff('cache-alpha'), fetchSessionDiff('cache-alpha')]);
  assert.deepEqual(calls, ['cache-alpha']);
  assert.equal(first.patch, PATCH);
  assert.equal(second.patch, PATCH);
});

test('N change signals during one in-flight read cause exactly one follow-up read', async () => {
  const gates = [];
  let calls = 0;
  globalThis.window = {
    mixdogDesktop: {
      invokeCapability: () => {
        calls += 1;
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      },
    },
  };
  const first = fetchSessionDiff('cache-burst', { force: true });
  const signals = Array.from({ length: 10 }, () => fetchSessionDiff('cache-burst', { force: true }));
  assert.equal(calls, 1);
  gates[0].resolve({ value: { ...RESULT, patch: 'stale' } });
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.equal(peekSessionDiff('cache-burst'), null, 'the superseded result is not retained');
  gates[1].resolve({ value: { ...RESULT, patch: 'fresh' } });
  const results = await Promise.all([first, ...signals]);
  assert.equal(calls, 2);
  assert.ok(results.every((result) => result.patch === 'fresh'));
  assert.equal(peekSessionDiff('cache-burst').patch, 'fresh');
});

test('a file slice comes from the settled result while a re-read is still running', async () => {
  const gate = deferred();
  globalThis.window = { mixdogDesktop: { invokeCapability: () => gate.promise } };
  primeSessionDiff('cache-slice', { ...RESULT });
  const reread = fetchSessionDiff('cache-slice', { force: true });
  const standalone = fetchSessionDiffFilePatch('cache-slice', 'src/owned.ts');
  const slice = await fetchSessionDiffFilePatchResult('cache-slice', { id: 'src/owned.ts', path: 'src/owned.ts' });
  assert.equal(slice.patch, PATCH);
  // The re-read settles as a new revision (what makes the list ask for its slices again), and the file it no longer
  // lists has no slice from then on.
  const before = sessionDiffRevision('cache-slice');
  gate.resolve({ value: { supported: true, files: [], patch: '' } });
  await reread;
  assert.equal(await standalone, '', 'a standalone file joins the refresh rather than showing the old list revision');
  assert.ok(sessionDiffRevision('cache-slice') > before);
  assert.equal((await fetchSessionDiffFilePatchResult('cache-slice', { id: 'src/owned.ts', path: 'src/owned.ts' })).patch, '');
  releaseSessionDiff('cache-slice');
});

test('no follow-up read when no signal arrived during the read', async () => {
  const calls = [];
  stubBackend(calls);
  await fetchSessionDiff('cache-quiet', { force: true });
  await fetchSessionDiff('cache-quiet');
  assert.equal(calls.length, 1);
});

test('matching patch length and digest cannot substitute an older file or parsed rows', async (t) => {
  // Force a collision in the digest without depending on a particular hash seed.
  t.mock.method(Math, 'imul', () => 0);
  const old = { ...RESULT };
  const newer = { ...RESULT, patch: PATCH.replace('+new', '+now') };
  let reply = old;
  globalThis.window = { mixdogDesktop: { invokeCapability: async () => ({ value: reply }) } };
  await fetchSessionDiff('collision');
  reply = newer;
  await fetchSessionDiff('collision', { force: true });
  assert.equal(sameSessionDiff(old, newer), false);
  assert.equal(await fetchSessionDiffFilePatch('collision', 'src/owned.ts'), newer.patch);
});

test('reopening after idle reclaim joins an outstanding refresh and receives the complete result', async () => {
  const gate = deferred();
  let reads = 0;
  globalThis.window = {
    mixdogDesktop: {
      invokeCapability: () => {
        reads += 1;
        return gate.promise;
      },
    },
  };
  primeSessionDiff('reopen', { supported: true, files: [], patch: '' });
  const refresh = fetchSessionDiff('reopen', { force: true });
  _runIdleReclaimForTest();
  assert.equal(peekSessionDiff('reopen'), null);
  const reopened = fetchSessionDiff('reopen');
  gate.resolve({ value: RESULT });
  assert.deepEqual(await Promise.all([refresh, reopened]), [RESULT, RESULT]);
  assert.equal(reads, 1);
  assert.equal(peekSessionDiff('reopen'), RESULT);
});

test('a settled result answers without a round-trip unless forced', async () => {
  const calls = [];
  stubBackend(calls);
  await fetchSessionDiff('cache-beta', { force: true });
  assert.equal(calls.length, 1);
  assert.equal(peekSessionDiff('cache-beta')?.patch, PATCH);
  await fetchSessionDiff('cache-beta');
  assert.equal(calls.length, 1);
  await fetchSessionDiff('cache-beta', { force: true });
  assert.equal(calls.length, 2);
});

test('a file slice reuses the shared result', async () => {
  const calls = [];
  stubBackend(calls);
  await fetchSessionDiff('cache-gamma', { force: true });
  const slice = await fetchSessionDiffFilePatch('cache-gamma', 'src/owned.ts');
  assert.match(slice, /\+new/);
  assert.equal(calls.length, 1);
});

test('a file listed without its patch is read on its own, once per result revision', async () => {
  const reads = [];
  globalThis.window = {
    mixdogDesktop: {
      invokeCapability: async ({ capability, args }) => {
        reads.push(capability);
        if (capability === 'getSessionReviewFilePatch') {
          return { value: { supported: true, path: args[0], patch: `patch of ${args[0]}` } };
        }
        return { value: null };
      },
    },
  };
  const listed = (additions) => ({
    supported: true,
    files: [{ path: 'big.txt', status: 'M', additions, deletions: 0, patchOmitted: true, reason: 'too_large' }],
    patch: '',
  });
  primeSessionDiff('cache-lazy', listed(5));
  const file = { id: 'big.txt', path: 'big.txt' };
  assert.deepEqual(await fetchSessionDiffFilePatchResult('cache-lazy', file), {
    patch: 'patch of big.txt',
    tooLarge: false,
  });
  await fetchSessionDiffFilePatchResult('cache-lazy', file);
  assert.deepEqual(reads, ['getSessionReviewFilePatch']);
  // The same result again keeps it; a changed one reads the file again.
  primeSessionDiff('cache-lazy', listed(5));
  await fetchSessionDiffFilePatchResult('cache-lazy', file);
  assert.equal(reads.length, 1);
  primeSessionDiff('cache-lazy', listed(6));
  assert.equal(await fetchSessionDiffFilePatch('cache-lazy', 'big.txt'), 'patch of big.txt');
  assert.equal(reads.length, 2);
  releaseSessionDiff('cache-lazy');
});

test('a forced read invalidates omitted-file patches even when counts and metadata are unchanged', async () => {
  let content = 'first';
  let patchReads = 0;
  globalThis.window = {
    mixdogDesktop: {
      invokeCapability: async ({ capability, args }) => {
        if (capability === 'getSessionReviewFilePatch') {
          patchReads += 1;
          return { value: { supported: true, path: args[0], patch: `patch ${content}` } };
        }
        return {
          value: {
            supported: true,
            files: [
              { path: 'big.txt', status: 'M', additions: 5, deletions: 1, patchOmitted: true, reason: 'too_large' },
            ],
            patch: '',
          },
        };
      },
    },
  };
  const file = { id: 'big.txt', path: 'big.txt' };
  await fetchSessionDiff('cache-same-counts', { force: true });
  assert.equal((await fetchSessionDiffFilePatchResult('cache-same-counts', file)).patch, 'patch first');
  assert.equal(sessionDiffRevision('cache-same-counts') > 0, true);
  // An unforced read of the settled result keeps the lazily read patch.
  await fetchSessionDiff('cache-same-counts');
  await fetchSessionDiffFilePatchResult('cache-same-counts', file);
  assert.equal(patchReads, 1);
  // The file's content changes; its counts and metadata do not.
  content = 'second';
  const before = sessionDiffRevision('cache-same-counts');
  await fetchSessionDiff('cache-same-counts', { force: true });
  assert.ok(sessionDiffRevision('cache-same-counts') > before);
  assert.equal((await fetchSessionDiffFilePatchResult('cache-same-counts', file)).patch, 'patch second');
  assert.equal(patchReads, 2);
  releaseSessionDiff('cache-same-counts');
});

test('answered signals are bounded like the result cache and released with the session', () => {
  globalThis.window = { mixdogDesktop: {} };
  for (let index = 0; index < 50; index += 1) answerSessionDiffSignal(`sig-${index}`, 'r');
  assert.equal(answeredSessionDiffSignal('sig-0'), undefined, 'the oldest entries are dropped');
  assert.equal(answeredSessionDiffSignal('sig-49'), 'r');
  releaseSessionDiff('sig-49');
  assert.equal(answeredSessionDiffSignal('sig-49'), undefined);
});

test('prime/peek/release manage the cache without the backend', async () => {
  const calls = [];
  stubBackend(calls);
  primeSessionDiff('cache-delta', RESULT);
  assert.equal(peekSessionDiff('cache-delta')?.patch, PATCH);
  await fetchSessionDiff('cache-delta');
  assert.equal(calls.length, 0);
  releaseSessionDiff('cache-delta');
  assert.equal(peekSessionDiff('cache-delta'), null);
});

test('a blank session never reaches the backend', async () => {
  const calls = [];
  stubBackend(calls);
  const result = await fetchSessionDiff('   ');
  assert.equal(result.supported, false);
  assert.equal(calls.length, 0);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('deleting a session fences its pending diff completion', async () => {
  const gate = deferred();
  globalThis.window = { mixdogDesktop: { invokeCapability: () => gate.promise } };
  const pending = fetchSessionDiff('deleted');
  releaseSessionDiff('deleted');
  gate.resolve({ value: RESULT });
  assert.equal((await pending).patch, PATCH);
  assert.equal(peekSessionDiff('deleted'), null);
});

test('an older completion or failure never replaces or releases a newer request', async () => {
  for (const failOld of [false, true]) {
    const old = deferred(),
      fresh = deferred();
    let calls = 0;
    globalThis.window = { mixdogDesktop: { invokeCapability: () => (++calls === 1 ? old : fresh).promise } };
    const before = fetchSessionDiff('race');
    const observed = before.catch(() => null);
    releaseSessionDiff('race');
    const after = fetchSessionDiff('race');
    if (failOld) old.reject(new Error('old failure'));
    else old.resolve({ value: { ...RESULT, patch: 'old' } });
    await observed;
    assert.equal(fetchSessionDiff('race'), after);
    fresh.resolve({ value: { ...RESULT, patch: 'new' } });
    await after;
    assert.equal(peekSessionDiff('race').patch, 'new');
  }
});

test('oversized diffs are delivered without being retained', async () => {
  const result = { ...RESULT, patch: 'x'.repeat(SESSION_DIFF_CACHE_MAX_CHARS + 1) };
  globalThis.window = { mixdogDesktop: { invokeCapability: async () => ({ value: result }) } };
  assert.equal((await fetchSessionDiff('large')).patch, result.patch);
  assert.equal(peekSessionDiff('large'), null);
});
