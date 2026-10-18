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

test('a slow model catalog read does not hold a snapshot read behind it', async () => {
  const queue = createRemoteCallQueue();
  const catalog = deferred();
  const seen = [];
  const models = queue.run('listProviderModels', async () => {
    await catalog.promise;
    seen.push('models');
  });
  await queue.run('getSnapshot', async () => {
    seen.push('snapshot');
  });
  assert.deepEqual(seen, ['snapshot']);
  catalog.resolve();
  await models;
  assert.deepEqual(seen, ['snapshot', 'models']);
  queue.close();
});

test('a slow model catalog read never fences a mutation, or the reads queued behind it', async () => {
  const queue = createRemoteCallQueue();
  const catalog = deferred();
  const seen = [];
  const models = queue.run('listProviderModels', async () => {
    await catalog.promise;
    seen.push('models');
  });
  await queue.run('getQuotaAutoResume', async () => seen.push('quota'));
  await queue.run('setQuotaAutoResume', async () => seen.push('write'));
  await queue.run('readSettings', async () => seen.push('settings'));
  assert.deepEqual(seen, ['quota', 'write', 'settings']);
  catalog.resolve();
  await models;
  queue.close();
});

test('file-name searches: the newest query under one scope wins, other scopes stand', async () => {
  const queue = createRemoteCallQueue(4, 2, 2, 1);
  const gate = deferred();
  const seen = [];
  const superseded = [];
  const search = (scope, query, task = async () => seen.push(query)) =>
    queue.run('searchProjectFiles', task, {
      latest: scope,
      superseded: async () => superseded.push(query),
    });
  // A cold index walk occupies the only slot.
  const running = search('a', 'r', async () => {
    seen.push('r');
    await gate.promise;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const typed = ['re', 'rea', 'read'].map((query) => search('a', query));
  const other = search('b', 'other');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(superseded, ['re', 'rea'], 'only the newest waiting query of a scope remains');
  gate.resolve();
  await Promise.all([running, ...typed, other]);
  assert.deepEqual(seen, ['r', 'read', 'other']);
  queue.close();
});

test('a slow turn review diff never fences the stat, read-mark or submit issued after it', async () => {
  const queue = createRemoteCallQueue();
  const review = deferred();
  const seen = [];
  const diff = queue.run('invokeCapability:getTurnReviewDiff', async () => {
    await review.promise;
    seen.push('review');
  });
  await queue.run('statProjectFile', async () => seen.push('stat'));
  await queue.run('markSessionRead', async () => seen.push('read-mark'));
  assert.deepEqual(seen, ['stat', 'read-mark']);
  review.resolve();
  await diff;
  assert.deepEqual(seen, ['stat', 'read-mark', 'review']);
  queue.close();
});

test('a transcription neither waits for in-flight reads nor fences later calls', async () => {
  const queue = createRemoteCallQueue();
  const read = deferred();
  const speech = deferred();
  const seen = [];
  const catalog = queue.run('listProviderModels', async () => {
    await read.promise;
    seen.push('catalog');
  });
  const transcribe = queue.run('invokeCapability:transcribeAudio', async () => {
    seen.push('transcribe-start');
    await speech.promise;
    seen.push('transcribe-end');
  });
  const warm = queue.run('invokeCapability:prepareTranscription', async () => {
    seen.push('prepare');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['transcribe-start', 'prepare']);
  await queue.run('getSnapshot', async () => seen.push('snapshot'));
  read.resolve();
  await Promise.all([catalog, warm]);
  await queue.run('markSessionRead', async () => seen.push('read-mark'));
  assert.deepEqual(seen, ['transcribe-start', 'prepare', 'snapshot', 'catalog', 'read-mark']);
  speech.resolve();
  await transcribe;
  assert.equal(seen.at(-1), 'transcribe-end');
  queue.close();
});

test('dictation calls observe mutations queued before them', async () => {
  const queue = createRemoteCallQueue();
  const gate = deferred();
  const seen = [];
  const write = queue.run('writeProjectFile', async () => {
    await gate.promise;
    seen.push('write');
  });
  const calls = ['invokeCapability:prepareTranscription', 'invokeCapability:transcribeAudio'].map((method) =>
    queue.run(method, async () => {
      seen.push(method);
    })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
  gate.resolve();
  await Promise.all([write, ...calls]);
  assert.deepEqual(seen, ['write', 'invokeCapability:prepareTranscription', 'invokeCapability:transcribeAudio']);
  queue.close();
});

test('disconnect rejects queued dictation calls', async () => {
  const queue = createRemoteCallQueue(4, 2, 1);
  const gate = deferred();
  let ran = 0;
  const running = queue.run('invokeCapability:transcribeAudio', async () => {
    ran += 1;
    await gate.promise;
  });
  const queued = queue.run('invokeCapability:transcribeAudio', async () => {
    ran += 1;
  });
  const rejected = assert.rejects(queued, /disconnected/);
  await new Promise((resolve) => setImmediate(resolve));
  queue.close();
  gate.resolve();
  await Promise.all([running, rejected]);
  assert.equal(ran, 1);
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

test('a usage sweep never holds the resume reads and snapshot queued after it', async () => {
  const queue = createRemoteCallQueue();
  const sweep = deferred();
  const seen = [];
  const usage = queue.run('readCapabilities:slow', async () => {
    await sweep.promise;
    seen.push('usage');
  });
  // The order a resuming phone sent them in (daemon.log, 2026-10-17 20:37:59).
  const resume = [
    'readActivityRailPins',
    'readHostDisplayPreferences',
    'getUpdaterState',
    'readSettings',
    'viewerDevice',
    'readCapabilities',
    'listProjects',
    'getSnapshot',
  ];
  await Promise.all(resume.map((method) => queue.run(method, async () => seen.push(method))));
  assert.deepEqual(seen, resume);
  sweep.resolve();
  await usage;
  assert.deepEqual(seen, [...resume, 'usage']);
  queue.close();
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
  // The slow and file-search lanes are bounded on their own: two calls run in
  // each, the rest wait.
  assert.deepEqual(
    seen.filter((entry) => entry !== 'search'),
    ['stat', 'capabilities', 'submit', 'new-task']
  );
  assert.equal(seen.filter((entry) => entry === 'search').length, 4);
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
  const running = queue.run('searchWorkspaceText', async () => {
    ran += 1;
    await gate.promise;
  });
  const queued = queue.run('searchWorkspaceText', async () => {
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

test('review reads ride the slow lane, so a snapshot read never waits behind them', async () => {
  for (const method of [
    'gitReview',
    'gitReviewDiff',
    'gitReviewDiffs',
    'invokeCapability:getSessionReviewFilePatch',
    'invokeCapability:getTurnReviewFilePatch',
  ]) {
    const queue = createRemoteCallQueue(4, 2);
    const release = deferred();
    const seen = [];
    // Fill the slow lane: a third review read waits there, not in the general lane.
    const first = queue.run(method, () => release.promise);
    const second = queue.run(method, () => release.promise);
    const third = queue.run(method, async () => seen.push('third'));
    await queue.run('getSnapshot', async () => seen.push('snapshot'));
    await queue.run('markSessionRead', async () => seen.push('read-mark'));
    assert.deepEqual(seen, ['snapshot', 'read-mark'], method);
    release.resolve();
    await Promise.all([first, second, third]);
    assert.deepEqual(seen, ['snapshot', 'read-mark', 'third'], method);
    queue.close();
  }
});

test('a hung resolveLocalPaths does not hold submit or settings calls behind it', async () => {
  const queue = createRemoteCallQueue();
  const hung = deferred();
  const seen = [];
  const resolving = queue.run('resolveLocalPaths', async () => {
    await hung.promise;
  });
  await queue.run('readSettings', async () => {
    seen.push('settings');
  });
  await queue.run('submitToSession', async () => {
    seen.push('submit');
  });
  assert.deepEqual(seen, ['settings', 'submit']);
  hung.resolve();
  await resolving;
  queue.close();
});
