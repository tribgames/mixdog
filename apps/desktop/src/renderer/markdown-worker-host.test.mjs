import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { MarkdownWorkerHost } from './markdown-worker-host.ts';

class FakeWorker {
  handlers = new Map();
  sent = [];
  terminated = 0;
  addEventListener(type, listener) {
    this.handlers.set(type, listener);
  }
  postMessage(value) {
    this.sent.push(value);
  }
  terminate() {
    this.terminated += 1;
  }
  emit(type, event) {
    this.handlers.get(type)?.(event);
  }
  reply(index = 0) {
    const { id, text } = this.sent[index];
    this.emit('message', {
      data: {
        id,
        root: { type: 'root', children: [{ type: 'text', value: text }] },
      },
    });
  }
}

test('the parser starts lazily on demand, terminates after idle inactivity, and respawns cleanly on the next parse', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers = [];
  const host = new MarkdownWorkerHost(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, 5_000);
  t.mock.timers.tick(120_000);
  assert.equal(workers.length, 0);
  assert.equal(host.active, false);

  const first = host.parse('one');
  assert.equal(workers.length, 1);
  assert.equal(host.active, true);
  // Idle termination refuses to kill a worker with an in-flight parse.
  assert.equal(host.terminateIdle(), false);
  t.mock.timers.tick(60_000);
  assert.equal(workers[0].terminated, 0, 'in-flight parse never times out the worker');

  workers[0].reply(0);
  assert.equal((await first).children[0].value, 'one');

  // After idleTimeoutMs with no in-flight work, the worker terminates without marking itself failed.
  t.mock.timers.tick(5_000);
  assert.equal(workers[0].terminated, 1);
  assert.equal(host.active, false);
  assert.equal(host.available, true);

  // Next parse lazily respawns a fresh worker.
  const second = host.parse('two');
  assert.equal(workers.length, 2);
  assert.equal(host.active, true);
  workers[1].reply(0);
  assert.equal((await second).children[0].value, 'two');
  assert.equal(host.terminateIdle(), true);
  assert.equal(workers[1].terminated, 1);
  assert.equal(host.active, false);
  assert.equal(host.available, true);

  // Default host stays warm during active use (does not self-terminate after 30s idle).
  const warmWorkers = [];
  const warmHost = new MarkdownWorkerHost(() => {
    const worker = new FakeWorker();
    warmWorkers.push(worker);
    return worker;
  });
  const warmParse = warmHost.parse('warm');
  warmWorkers[0].reply(0);
  assert.equal((await warmParse).children[0].value, 'warm');
  t.mock.timers.tick(120_000);
  assert.equal(warmWorkers[0].terminated, 0, 'default worker stays warm during active app use');
  assert.equal(warmHost.active, true);
  assert.equal(warmHost.terminateIdle(), true, 'explicit memory pressure still reclaims the idle worker');
  assert.equal(warmHost.active, false);
});

for (const type of ['error', 'messageerror']) {
  test(`${type} rejects all pending work and does not recreate a broken bootstrap`, async () => {
    const worker = new FakeWorker();
    let creations = 0;
    let prevented = 0;
    const host = new MarkdownWorkerHost(() => {
      creations += 1;
      return worker;
    });
    const first = host.parse('one');
    const second = host.parse('two');
    const settled = Promise.allSettled([first, second]);
    worker.emit(type, {
      message: 'failed',
      preventDefault() {
        prevented += 1;
      },
    });
    assert.deepEqual(
      (await settled).map((result) => result.status),
      ['rejected', 'rejected']
    );
    await assert.rejects(host.parse('later'));
    assert.equal(prevented, 1);
    assert.equal(creations, 1);
    assert.equal(worker.terminated, 1);
  });
}

test('a failed post rejects only its own parse and keeps the parser', async () => {
  const worker = new FakeWorker();
  const post = worker.postMessage.bind(worker);
  let failPost = true;
  worker.postMessage = (value) => {
    if (failPost) throw new Error('clone failed');
    post(value);
  };
  const host = new MarkdownWorkerHost(() => worker);
  await assert.rejects(host.parse('bad'), /clone failed/);
  failPost = false;
  const next = host.parse('good');
  worker.reply(0);
  assert.equal((await next).children[0].value, 'good');
  assert.equal(worker.terminated, 0);
});

test('client parses off-main-thread via lazy worker, deduplicates concurrent requests, terminates worker on idle reclaim, checks idle prefetch deadline, and falls back on worker failure', async (t) => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const originalIdle = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback');
  const workers = [];
  const idleQueue = [];
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class extends FakeWorker {
      constructor() {
        super();
        workers.push(this);
      }
    },
  });
  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    value: (callback) => {
      idleQueue.push(callback);
      return idleQueue.length;
    },
  });
  const {
    HIDDEN_WORKER_RECLAIM_MS,
    isMarkdownWorkerActive,
    parseStreamingMarkdownAst,
    prefetchMarkdownAsts,
    preloadSyncMarkdownParser,
    readCachedStreamingMarkdownAst,
    syncMarkdownParserLoad,
  } = await import('./markdown-worker-client.ts');
  const { _runIdleReclaimForTest } = await import('./idle-reclaim.ts');
  try {
    // 1. Preload does not spawn a worker; a speculative preload failure is recorded and recoverable.
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === './markdown-ast' && context.parentURL?.includes('markdown-worker-client')) {
          throw new Error('simulated preload failure');
        }
        return nextResolve(specifier, context);
      },
    });
    try {
      await preloadSyncMarkdownParser();
      assert.match(syncMarkdownParserLoad().error.message, /simulated preload failure/);
    } finally {
      hooks.deregister();
    }
    assert.equal(workers.length, 0, 'preloading sync parser never spawns a worker');

    // 2. Async parses route through the lazy worker and deduplicate identical concurrent requests.
    const requests = Array.from({ length: 50 }, () => parseStreamingMarkdownAst('shared'));
    assert.equal(workers.length, 1, 'first async parse lazily spawns the worker');
    assert.equal(isMarkdownWorkerActive(), true);
    assert.equal(workers[0].sent.length, 1, 'concurrent identical requests share one worker message');
    workers[0].reply(0);
    const roots = await Promise.all(requests);
    assert.ok(roots.every((root) => root === roots[0]));
    assert.equal(readCachedStreamingMarkdownAst('shared'), roots[0]);

    // 3. Idle reclaim drops the AST cache and terminates the idle worker; next parse respawns it.
    _runIdleReclaimForTest();
    assert.equal(readCachedStreamingMarkdownAst('shared'), null, 'idle reclaim drops the AST cache');
    assert.equal(workers[0].terminated, 1, 'idle reclaim terminates the idle worker');
    assert.equal(isMarkdownWorkerActive(), false);

    const flushMicrotasks = async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };
    // 4. Prefetch respects deadline.timeRemaining(): zero budget defers instead of starting a parse.
    prefetchMarkdownAsts(['prefetched-block']);
    assert.equal(idleQueue.length, 1);
    idleQueue.shift()({ didTimeout: false, timeRemaining: () => 0 });
    assert.equal(workers.length, 1, 'zero-budget idle turn must not spawn/dispatch a prefetch parse');
    assert.equal(idleQueue.length, 1, 'zero-budget turn reschedules prefetch');
    idleQueue.shift()({ didTimeout: false, timeRemaining: () => 5 });
    assert.equal(workers.length, 2, 'idle turn with remaining time respawns the worker for prefetch');
    workers[1].reply(0);
    await flushMicrotasks();
    assert.ok(readCachedStreamingMarkdownAst('prefetched-block'));

    // 4b. Repeated prefetchMarkdownAsts + idle ticks never exceed bounded in-flight concurrency (1).
    const sentBefore = workers[1].sent.length;
    prefetchMarkdownAsts(['scroll-a', 'scroll-b']);
    assert.equal(idleQueue.length, 1);
    idleQueue.shift()({ didTimeout: false, timeRemaining: () => 5 });
    assert.equal(workers[1].sent.length, sentBefore + 1, 'dispatches one in-flight prefetch parse');
    assert.equal(workers[1].sent.at(-1).text, 'scroll-a');
    // Scrolling replaces the queue while scroll-a is still in flight; no new idle turn or postMessage fires yet.
    prefetchMarkdownAsts(['scroll-c', 'scroll-d']);
    prefetchMarkdownAsts(['scroll-e', 'scroll-f']);
    assert.equal(idleQueue.length, 0, 'does not schedule another idle turn while a prefetch parse is in flight');
    assert.equal(workers[1].sent.length, sentBefore + 1, 'never dispatches concurrent speculative prefetches');
    // Settling scroll-a pumps only the latest queued range, one item at a time.
    workers[1].reply(sentBefore);
    await flushMicrotasks();
    assert.equal(idleQueue.length, 1, 'schedules the next prefetch turn once the in-flight prefetch settles');
    idleQueue.shift()({ didTimeout: false, timeRemaining: () => 5 });
    assert.equal(workers[1].sent.length, sentBefore + 2);
    assert.equal(workers[1].sent.at(-1).text, 'scroll-e', 'pumps the newest queued text, skipping replaced entries');
    workers[1].reply(sentBefore + 1);
    await flushMicrotasks();
    idleQueue.shift()({ didTimeout: false, timeRemaining: () => 5 });
    assert.equal(workers[1].sent.at(-1).text, 'scroll-f');
    workers[1].reply(sentBefore + 2);
    await flushMicrotasks();
    assert.equal(idleQueue.length, 0);
    assert.equal(readCachedStreamingMarkdownAst('scroll-c'), null, 'superseded queue item was never parsed');
    assert.ok(readCachedStreamingMarkdownAst('scroll-e'));
    assert.ok(readCachedStreamingMarkdownAst('scroll-f'));

    // 4c. A parse completing while document.visibilityState === 'hidden' re-arms the hidden reclaim timer.
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const docListeners = new Map();
    const fakeDocument = {
      visibilityState: 'hidden',
      addEventListener(type, listener) {
        const list = docListeners.get(type) ?? [];
        list.push(listener);
        docListeners.set(type, list);
      },
    };
    const emitVisibility = (state) => {
      fakeDocument.visibilityState = state;
      for (const listener of docListeners.get('visibilitychange') ?? []) listener();
    };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    try {
      await t.test('hidden worker reclaim re-arms after parses settle while hidden', async (sub) => {
        sub.mock.timers.enable({ apis: ['setTimeout'] });
        // Active worker completes a parse while already hidden -> timer arms and terminates after HIDDEN_WORKER_RECLAIM_MS.
        const hiddenFirst = parseStreamingMarkdownAst('hidden-parse-1');
        sub.mock.timers.tick(HIDDEN_WORKER_RECLAIM_MS);
        assert.equal(workers[1].terminated, 0, 'in-flight parse prevents hidden termination');
        workers[1].reply(workers[1].sent.length - 1);
        await hiddenFirst;
        sub.mock.timers.tick(HIDDEN_WORKER_RECLAIM_MS - 1);
        assert.equal(workers[1].terminated, 0, 'worker stays alive until full hidden reclaim delay elapses');
        // Starting another parse clears the old timer; completing it re-arms a fresh delay.
        const hiddenSecond = parseStreamingMarkdownAst('hidden-parse-2');
        sub.mock.timers.tick(HIDDEN_WORKER_RECLAIM_MS);
        assert.equal(workers[1].terminated, 0);
        workers[1].reply(workers[1].sent.length - 1);
        await hiddenSecond;
        sub.mock.timers.tick(HIDDEN_WORKER_RECLAIM_MS - 1);
        assert.equal(workers[1].terminated, 0, 're-armed hidden reclaim delay counts from parse settlement');
        sub.mock.timers.tick(1);
        assert.equal(workers[1].terminated, 1, 'idle worker terminates once re-armed hidden timer elapses');
        assert.equal(isMarkdownWorkerActive(), false);

        // Spawning a fresh worker while already hidden also arms reclaim on settlement, cancelled if visible returns.
        const spawnedHidden = parseStreamingMarkdownAst('hidden-spawn-1');
        assert.equal(workers.length, 3);
        workers[2].reply(0);
        await spawnedHidden;
        sub.mock.timers.tick(HIDDEN_WORKER_RECLAIM_MS - 1);
        emitVisibility('visible');
        sub.mock.timers.tick(HIDDEN_WORKER_RECLAIM_MS);
        assert.equal(workers[2].terminated, 0, 'returning to visible cancels the pending hidden reclaim timer');
        assert.equal(isMarkdownWorkerActive(), true);
      });
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else delete globalThis.document;
    }

    // 5. Worker crash falls back cleanly to the main-thread parser (recovering the earlier preload failure).
    const fallbackPending = parseStreamingMarkdownAst('**recovered**');
    workers.at(-1).emit('error', { message: 'worker crashed', preventDefault() {} });
    const recovered = await fallbackPending;
    assert.equal(recovered.children[0].children[0].tagName, 'strong');
  } finally {
    _runIdleReclaimForTest();
    if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
    else delete globalThis.Worker;
    if (originalIdle) Object.defineProperty(globalThis, 'requestIdleCallback', originalIdle);
    else delete globalThis.requestIdleCallback;
  }
});
