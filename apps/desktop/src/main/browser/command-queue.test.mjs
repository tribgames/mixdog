import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserCommandQueue } from './command-queue.ts';

function takeoverFixture(run) {
  return createBrowserCommandQueue({
    chains: new Map(), pendingReads: new Map(),
    sessionId: command => command.session_id || 'owner',
    backgroundEntryByPageId: () => null, run,
    bounded: async (work, _timeout, _label, signal) => {
      signal.throwIfAborted();
      let abort;
      try {
        return await Promise.race([work, new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        })]);
      } finally { signal.removeEventListener('abort', abort); }
    },
    readOnlyActions: new Set(['snapshot']), commandTimeoutMs: 42_000,
  });
}

test('human takeover cancels active and queued foreground automation without interrupting independent pages', async () => {
  const events = [];
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const queue = takeoverFixture(async (command, signal) => {
    events.push(command.action);
    if (command.action === 'wait') {
      entered();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return { text: 'done' };
  });
  const active = queue.executeSerialized({ action: 'wait' });
  const cancelled = assert.rejects(active, /interrupted by local user input/);
  await started;
  const queued = queue.executeSerialized({ action: 'click' });
  const dropped = assert.rejects(queued, /interrupted by local user input/);
  await queue.executeLocal({ action: 'remote_control' }, async () => { events.push('human'); }, { takeover: true });
  await Promise.all([cancelled, dropped]);
  assert.deepEqual(events, ['wait', 'human']);
  await assert.rejects(queue.executeSerialized({ action: 'click' }), /observe the page again/);
  await Promise.all([
    queue.executeSerialized({ action: 'background', background: true, tab: 'research' }),
    queue.executeSerialized({ action: 'other', session_id: 'other' }),
  ]);
  assert.deepEqual(events, ['wait', 'human', 'background', 'other']);
});

test('takeover retains the real in-flight dispatch fence after its caller is cancelled', async () => {
  let finish;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const queue = takeoverFixture(async () => { entered(); await gate; return { text: 'done' }; });
  const agent = queue.executeSerialized({ action: 'click' });
  const cancelled = assert.rejects(agent, /interrupted by local user input/);
  await started;
  let sent = false;
  const local = queue.executeLocal({ action: 'remote_control' }, async () => { sent = true; }, { takeover: true });
  try {
    await cancelled;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent, false, 'a cancelled response is not proof the edit stopped');
  } finally { finish(); await local; }
  assert.equal(sent, true);
});

test('hover yields to automation, and a held human pointer excludes agent edits until release and idle', async () => {
  let finish;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  let agentSignal;
  const queue = takeoverFixture(async (_command, signal) => {
    agentSignal = signal; entered(); await gate; return { text: 'done' };
  });
  const command = { action: 'remote_control' };
  const agent = queue.executeSerialized({ action: 'snapshot' });
  await started;
  try {
    await queue.executeLocal(command, async () => assert.fail('hover should be dropped'),
      { takeover: false, dropIfBusy: true });
    assert.equal(agentSignal.aborted, false);
  } finally { finish(); await agent; }
  await queue.executeLocal(command, async () => {}, { takeover: true, held: true });
  await new Promise(resolve => setTimeout(resolve, 1_050));
  await assert.rejects(queue.executeSerialized({ action: 'click' }), /local user input/);
  await queue.executeLocal(command, async () => {}, { takeover: true, held: false });
  await assert.rejects(queue.executeSerialized({ action: 'click' }), /local user input/);
  await new Promise(resolve => setTimeout(resolve, 1_050));
  await queue.executeSerialized({ action: 'snapshot' });
});

test('another local input never aborts a dispatched human edit', async () => {
  const queue = takeoverFixture(async () => ({ text: 'unused' }));
  let finish;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  let firstSignal;
  const sent = [];
  const command = { action: 'remote_control' };
  const first = queue.executeLocal(command, async signal => {
    firstSignal = signal; entered(); await gate; sent.push('first');
  }, { takeover: true });
  await started;
  const second = queue.executeLocal(command, async () => { sent.push('second'); }, { takeover: true });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(firstSignal.aborted, false);
    assert.deepEqual(sent, []);
  } finally { finish(); await Promise.all([first, second]); }
  assert.deepEqual(sent, ['first', 'second']);
});

test('local admission expires behind an agent without dispatching later or releasing its serialization fence', async () => {
  let release;
  const previous = new Promise(resolve => { release = resolve; });
  const sent = [];
  const queue = createBrowserCommandQueue({
    chains: new Map([['foreground', previous]]), pendingReads: new Map(),
    backgroundEntryByPageId: () => null, run: async () => ({ text: '' }),
    bounded: async operation => await operation,
    readOnlyActions: new Set(), commandTimeoutMs: 42_000,
  });
  try {
    const expired = queue.executeSerialized({ action: 'remote_control' }, undefined,
      async () => { sent.push('expired'); }, 10);
    await assert.rejects(expired, /input expired; input was not sent/);
    const next = queue.executeSerialized({ action: 'remote_control' }, undefined,
      async () => { sent.push('next'); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, []);
    release();
    await next;
    assert.deepEqual(sent, ['next']);
  } finally { release(); }
});

test('an admission deadline does not cancel an edit after dispatch has started', async () => {
  const controller = new AbortController();
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = createBrowserCommandQueue({
    chains: new Map(), pendingReads: new Map(), backgroundEntryByPageId: () => null,
    run: async () => ({ text: '' }), bounded: async operation => await operation,
    readOnlyActions: new Set(), commandTimeoutMs: 42_000,
  });
  let dispatchSignal;
  const work = queue.executeSerialized({ action: 'remote_control' }, controller.signal,
    async signal => { dispatchSignal = signal; started(); await gate; }, 10);
  try {
    await entered;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(dispatchSignal.aborted, false);
  } finally { release(); await work; }
});

test('queued Browser Use commands release immediately when cancelled before dispatch', async () => {
  let releasePrevious;
  const previous = new Promise((resolve) => {
    releasePrevious = resolve;
  });
  const chains = new Map([['foreground', previous]]);
  let dispatches = 0;
  const queue = createBrowserCommandQueue({
    chains,
    pendingReads: new Map(),
    backgroundEntryByPageId: () => null,
    run: async () => {
      dispatches += 1;
      return { text: 'unexpected' };
    },
    bounded: async (operation) => await operation,
    readOnlyActions: new Set(),
    commandTimeoutMs: 45_000,
  });
  const controller = new AbortController();
  const pending = queue.executeSerialized({ action: 'open' }, controller.signal);
  controller.abort(new Error('fixture cancelled'));
  await assert.rejects(pending, /fixture cancelled/);
  assert.equal(dispatches, 0);
  const next = queue.executeSerialized({ action: 'open' });
  await Promise.resolve();
  assert.equal(dispatches, 0);
  releasePrevious();
  await next;
  assert.equal(dispatches, 1);
});
