// The host decides once, at a turn's end, which of the turn's file opens
// (named by tool call id) have nothing left to show (closed, or their files
// gone), records it on the session's state, and every window and device
// receives it with the state.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { remoteVisualizeState } from '../../shared/visualize.ts';
import { createVisualizeService } from './service.ts';

function setup(overrides = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-gone-opens-')));
  for (const name of ['a', 'b', 'c']) {
    mkdirSync(join(cwd, name), { recursive: true });
    writeFileSync(join(cwd, name, 'index.html'), `<h1>${name}</h1>`);
  }
  const events = [];
  let prepared = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => true,
    async preparePane(target) {
      prepared += 1;
      return `http://127.0.0.1:1/${'t'.repeat(32)}/${target.label}?${prepared}`;
    },
    publish: (event) => events.push(event),
    publishHost: () => {},
    watch: () => () => {},
    annotate: async () => [],
    async capture() {
      return Buffer.from('SCREEN');
    },
    async onScreen() {
      return 'visible';
    },
    delay: async () => {},
    reloadDebounceMs: 5,
    ...overrides,
  });
  const run = (sessionId, action, input, callId) =>
    service.execute({ sessionId, cwd, action, input, ...(callId ? { callId } : {}) });
  const gone = (sessionId) => service.snapshot().find((state) => state.sessionId === sessionId)?.goneOpens ?? [];
  return {
    cwd,
    events,
    service,
    run,
    gone,
    remove: (name) => rmSync(join(cwd, name), { recursive: true, force: true }),
    cleanup() {
      service.dispose();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test('deleted and closed in the same turn: the turn end records that open, in every state a client reads', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive('s1', true);
    await t.run('s1', 'open', { targets: ['a/index.html'] }, 'call-1');
    t.remove('a');
    await t.run('s1', 'close', { tab: 'v1' });
    assert.deepEqual(t.gone('s1'), [], 'nothing is decided while the turn runs');
    await t.service.setTurnActive('s1', false);

    assert.deepEqual(t.gone('s1'), [{ tab: 'v1', call: 'call-1' }]);
    const final = t.events.filter((event) => !event.held).at(-1);
    assert.deepEqual(final.state.goneOpens, [{ tab: 'v1', call: 'call-1' }], 'published with the final state');
    // A device that connects later reads it from the snapshot lane.
    const host = t.service.hostSnapshot().find((state) => state.sessionId === 's1');
    assert.deepEqual(host.goneOpens, [{ tab: 'v1', call: 'call-1' }]);
    assert.deepEqual(remoteVisualizeState(host).goneOpens, [{ tab: 'v1', call: 'call-1' }]);
  } finally {
    t.cleanup();
  }
});

test('opened and closed in the same turn: recorded; one still open and present: not; no call id: nothing named', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive('s1', true);
    await t.run('s1', 'open', { targets: ['a/index.html'] }, 'call-a');
    await t.run('s1', 'open', { targets: ['b/index.html'] }, 'call-b');
    await t.run('s1', 'open', { targets: ['c/index.html'] });
    await t.run('s1', 'close', { tab: 'v1' });
    await t.run('s1', 'close', { tab: 'v3' });
    await t.service.setTurnActive('s1', false);
    assert.deepEqual(t.gone('s1'), [{ tab: 'v1', call: 'call-a' }]);
  } finally {
    t.cleanup();
  }
});

test('a file deleted while its tab stays open (no watcher event) is found at the turn end', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive('s1', true);
    await t.run('s1', 'open', { targets: ['a/index.html'] }, 'call-a');
    await t.run('s1', 'open', { targets: ['b/index.html'] }, 'call-b');
    t.remove('a');
    await t.service.setTurnActive('s1', false);
    assert.deepEqual(t.gone('s1'), [{ tab: 'v1', call: 'call-a' }]);
  } finally {
    t.cleanup();
  }
});

test('adjacent turns reopening one tab: the later turn’s record names only its own call', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive('s1', true);
    await t.run('s1', 'open', { targets: ['a/index.html'] }, 'turn1-open');
    await t.service.setTurnActive('s1', false);
    assert.deepEqual(t.gone('s1'), []);
    // The next turn starts at once, opens the same tab again, loses it.
    await t.service.setTurnActive('s1', true);
    await t.run('s1', 'open', { targets: ['a/index.html'] }, 'turn2-open');
    t.remove('a');
    await t.run('s1', 'close', { tab: 'v1' });
    await t.service.setTurnActive('s1', false);
    assert.deepEqual(t.gone('s1'), [{ tab: 'v1', call: 'turn2-open' }], 'turn 1’s open is not named');
  } finally {
    t.cleanup();
  }
});

test('a close or deletion after its turn ended records nothing for that turn', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive('s1', true);
    await t.run('s1', 'open', { targets: ['a/index.html'] }, 'call-a');
    await t.service.setTurnActive('s1', false);
    t.remove('a');
    await t.run('s1', 'close', { tab: 'v1' });
    assert.deepEqual(t.gone('s1'), []);
  } finally {
    t.cleanup();
  }
});

test('a stat that never answers cannot hold the turn end: the open counts as present, release and publish complete', async () => {
  const t = setup({ statFile: () => new Promise(() => {}), goneCheckBudgetMs: 50 });
  try {
    await t.service.setTurnActive('s1', true);
    await t.run('s1', 'open', { targets: ['a/index.html'] }, 'call-a');
    await t.run('s1', 'open', { targets: ['b/index.html'] }, 'call-b');
    t.remove('a');
    const before = Date.now();
    await t.service.setTurnActive('s1', false);
    assert.ok(Date.now() - before < 2000, 'the end waited only for the short budget');
    assert.deepEqual(t.gone('s1'), [], 'undetermined = present: every card stays');
    const final = t.events.filter((event) => !event.held).at(-1);
    assert.equal(final.state.tabs.length, 2, 'the final state was published');
    assert.equal(final.reveal, true);
  } finally {
    t.cleanup();
  }
});

test('sessions are isolated, and a session’s record goes with its state', async () => {
  const t = setup();
  try {
    for (const session of ['s1', 's2']) {
      await t.service.setTurnActive(session, true);
      await t.run(session, 'open', { targets: ['c/index.html'] }, `${session}-open`);
    }
    await t.run('s1', 'close', { tab: 'v1' });
    await t.service.setTurnActive('s1', false);
    await t.service.setTurnActive('s2', false);
    assert.deepEqual(t.gone('s1'), [{ tab: 'v1', call: 's1-open' }]);
    assert.deepEqual(t.gone('s2'), [], 'the other session’s same tab id is untouched');
    t.service.dispose();
    assert.deepEqual(t.service.snapshot(), [], 'the record is not kept outside the session state');
  } finally {
    t.cleanup();
  }
});
