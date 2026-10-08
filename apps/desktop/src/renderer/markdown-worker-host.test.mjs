import assert from 'node:assert/strict';
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

test('the parser starts on demand, then stays resident across idle time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers = [];
  const host = new MarkdownWorkerHost(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  t.mock.timers.tick(120_000);
  assert.equal(workers.length, 0);
  host.prewarm();
  host.prewarm();
  assert.equal(workers.length, 1);
  t.mock.timers.tick(600_000);
  const first = host.parse('one');
  workers[0].reply(0);
  assert.equal((await first).children[0].value, 'one');
  t.mock.timers.tick(600_000);
  const second = host.parse('two');
  workers[0].reply(1);
  assert.equal((await second).children[0].value, 'two');
  assert.equal(workers.length, 1, 'the prewarmed parser serves every later parse');
  assert.equal(workers[0].terminated, 0);
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

test('client boots one resident parser, shares concurrent parses and preserves fallback recovery', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const workers = [];
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class extends FakeWorker {
      constructor() {
        super();
        workers.push(this);
      }
    },
  });
  const { parseStreamingMarkdownAst } = await import('./markdown-worker-client.ts');
  const { _runIdleReclaimForTest } = await import('./idle-reclaim.ts');
  try {
    assert.equal(workers.length, 1, 'the parser boots with the client, before any parse');
    const requests = Array.from({ length: 50 }, () => parseStreamingMarkdownAst('shared'));
    assert.equal(workers[0].sent.length, 1);
    workers[0].reply(0);
    const roots = await Promise.all(requests);
    assert.ok(roots.every((root) => root === roots[0]));
    _runIdleReclaimForTest();
    assert.equal(workers[0].terminated, 0, 'idle reclaim keeps the resident parser');
    const next = parseStreamingMarkdownAst('shared');
    assert.equal(workers[0].sent.length, 2, 'idle reclaim drops the AST cache');
    workers[0].reply(1);
    await next;
    const recovered = [parseStreamingMarkdownAst('**recovered**'), parseStreamingMarkdownAst('**recovered**')];
    workers[0].emit('error', { message: 'bootstrap failed', preventDefault() {} });
    const fallback = await Promise.all(recovered);
    assert.equal(fallback[0], fallback[1]);
    assert.equal(fallback[0].children[0].children[0].tagName, 'strong');
    await parseStreamingMarkdownAst('after failure');
    assert.equal(workers.length, 1);
  } finally {
    _runIdleReclaimForTest();
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else delete globalThis.Worker;
  }
});
