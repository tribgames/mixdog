import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteCallQueue } from './remote-call-queue.ts';

const deferred = () => Promise.withResolvers();

test('terminal input bypasses unrelated work while terminal lifecycle stays ordered', async () => {
  const queue = createRemoteCallQueue();
  const unrelated = deferred();
  const ready = deferred();
  const seen = [];
  const slow = queue.run('getVoiceStatus', async () => {
    await unrelated.promise;
  });
  const ensure = queue.run('termEnsure', async () => {
    seen.push('ensure');
    await ready.promise;
  });
  const writes = ['한', '글', '\r'].map((data) =>
    queue.run('termWrite', async () => {
      seen.push(data);
    })
  );
  const resize = queue.run('termResize', async () => {
    seen.push('resize');
  });
  const dispose = queue.run('termDispose', async () => {
    seen.push('dispose');
  });
  await Promise.resolve();
  assert.deepEqual(seen, ['ensure']);
  ready.resolve();
  await Promise.all([ensure, ...writes, resize, dispose]);
  assert.deepEqual(seen, ['ensure', '한', '글', '\r', 'resize', 'dispose']);
  unrelated.resolve();
  await slow;
  queue.close();
});

test('disconnect rejects queued terminal input without replaying it', async () => {
  const queue = createRemoteCallQueue();
  const gate = deferred();
  const running = queue.run('termEnsure', async () => {
    await gate.promise;
  });
  let writes = 0;
  const queued = queue.run('termWrite', async () => {
    writes += 1;
  });
  const rejected = assert.rejects(queued, /disconnected/);
  await Promise.resolve();
  queue.close();
  gate.resolve();
  await Promise.all([running, rejected]);
  await assert.rejects(
    queue.run('termWrite', async () => {
      writes += 1;
    }),
    /disconnected/
  );
  assert.equal(writes, 0);
});

test('a slow read does not block another read; mutations remain ordered barriers', async () => {
  const queue = createRemoteCallQueue(2);
  const slow = deferred();
  const started = deferred();
  const seen = [];
  const first = queue.run('readProjectFile', async () => {
    seen.push('read-start');
    started.resolve();
    await slow.promise;
    seen.push('read-end');
  });
  await started.promise;
  await queue.run('getSnapshot', async () => {
    seen.push('snapshot');
  });
  assert.deepEqual(seen, ['read-start', 'snapshot']);
  const write = queue.run('writeProjectFile', async () => {
    seen.push('write');
  });
  const after = queue.run('getSnapshot', async () => {
    seen.push('after-write');
  });
  await Promise.resolve();
  assert.equal(seen.includes('write'), false);
  slow.resolve();
  await Promise.all([first, write, after]);
  assert.deepEqual(seen, ['read-start', 'snapshot', 'read-end', 'write', 'after-write']);
});

test('slow searches never delay a stat, capability read or submit issued after them', async () => {
  const queue = createRemoteCallQueue();
  const gate = deferred();
  const seen = [];
  const searches = Array.from({ length: 8 }, (_, index) =>
    queue.run(['searchProjectFiles', 'searchWorkspaceText', 'previewDocumentPages'][index % 3], async () => {
      seen.push('search');
      await gate.promise;
    })
  );
  await queue.run('statProjectFile', async () => {
    seen.push('stat');
  });
  await queue.run('readCapabilities', async () => {
    seen.push('capabilities');
  });
  await queue.run('submitToSession', async () => {
    seen.push('submit');
  });
  await queue.run('submitNewTask', async () => {
    seen.push('new-task');
  });
  // The slow lane is bounded on its own: two searches run, the rest wait.
  assert.deepEqual(
    seen.filter((entry) => entry !== 'search'),
    ['stat', 'capabilities', 'submit', 'new-task']
  );
  assert.equal(seen.filter((entry) => entry === 'search').length, 2);
  gate.resolve();
  await Promise.all(searches);
  assert.equal(seen.filter((entry) => entry === 'search').length, 8);
  queue.close();
});

test('a slow capability read does not fence the reads issued after it', async () => {
  const queue = createRemoteCallQueue();
  const gate = deferred();
  const seen = [];
  const read = queue.run('readCapabilities', async () => {
    await gate.promise;
    seen.push('capabilities');
  });
  await queue.run('listSessions', async () => {
    seen.push('sessions');
  });
  assert.deepEqual(seen, ['sessions']);
  gate.resolve();
  await read;
  queue.close();
});

test('a slow search observes mutations queued before it', async () => {
  const queue = createRemoteCallQueue();
  const gate = deferred();
  const seen = [];
  const write = queue.run('writeProjectFile', async () => {
    await gate.promise;
    seen.push('write');
  });
  const search = queue.run('searchProjectFiles', async () => {
    seen.push('search');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
  gate.resolve();
  await Promise.all([write, search]);
  assert.deepEqual(seen, ['write', 'search']);
  queue.close();
});

test('disconnect rejects queued slow searches', async () => {
  const queue = createRemoteCallQueue(4, 1);
  const gate = deferred();
  let ran = 0;
  const running = queue.run('searchProjectFiles', async () => {
    ran += 1;
    await gate.promise;
  });
  const queued = queue.run('searchProjectFiles', async () => {
    ran += 1;
  });
  const rejected = assert.rejects(queued, /disconnected/);
  await Promise.resolve();
  queue.close();
  gate.resolve();
  await Promise.all([running, rejected]);
  assert.equal(ran, 1);
});

test('read concurrency is bounded and disconnect never starts queued mutations', async () => {
  const queue = createRemoteCallQueue(2);
  const gate = deferred();
  let active = 0,
    peak = 0,
    writes = 0;
  const reads = Array.from({ length: 5 }, () =>
    queue.run('getSnapshot', async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    })
  );
  const write = queue.run('submitToSession', async () => {
    writes += 1;
  });
  const settled = Promise.allSettled([...reads, write]);
  await Promise.resolve();
  assert.equal(peak, 2);
  queue.close();
  gate.resolve();
  const results = await settled;
  assert.equal(writes, 0);
  assert.equal(results.filter((row) => row.status === 'rejected').length, 4);
});
