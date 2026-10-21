import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_FOLLOW_TRIES, createBrowserAgentFollow } from './browser-agent-follow.ts';

const strip = (active, ...ids) =>
  ids.map((id) => ({ id, title: id, url: id, loading: false, kind: 'page', active: id === active }));
const agent = (tabId, turn = 1, paused = false) => ({ tabId, turn, paused });
const settled = () => new Promise((resolve) => setImmediate(resolve));

// A manual clock: retries run only when the test fires them.
function clock() {
  const queue = [];
  return {
    later(run) {
      const entry = { run, live: true };
      queue.push(entry);
      return () => {
        entry.live = false;
      };
    },
    fire() {
      const due = queue.splice(0).filter((entry) => entry.live);
      for (const entry of due) entry.run();
      return due.length;
    },
  };
}

function setup(outcome = () => undefined) {
  const picked = [];
  const time = clock();
  const follow = createBrowserAgentFollow((id, mode) => {
    picked.push([id, mode]);
    return outcome(picked.length);
  }, time.later);
  return { follow, picked, time };
}

test('a popup the agent drives is selected over the blank tab, once', () => {
  const { follow, picked } = setup();
  follow.observe(agent('p1'), strip('p1', 'p1'));
  assert.deepEqual(picked, []);
  follow.observe(agent('p2'), strip('p1', 'p1', 'p2'));
  follow.observe(agent('p2'), strip('p1', 'p1', 'p2'));
  assert.deepEqual(picked, [['p2', 'agent']]);
});

test('a page not listed yet is retried when the strip catches up', () => {
  const { follow, picked } = setup();
  follow.observe(agent('p2'), strip('p1', 'p1'));
  assert.deepEqual(picked, []);
  follow.observe(agent('p2'), strip('p1', 'p1', 'p2'));
  assert.deepEqual(picked, [['p2', 'agent']]);
});

test('a slow selection is not asked again while it is pending', async () => {
  const { follow, picked } = setup(() => new Promise(() => {}));
  follow.observe(agent('p2'), strip('p1', 'p1', 'p2'));
  await settled();
  follow.observe(agent('p2'), strip('p1', 'p1', 'p2'));
  assert.equal(picked.length, 1);
});

test('a rejected selection is retried on the next sample, a bounded number of times', async () => {
  const { follow, picked } = setup(() => Promise.reject(new Error('Browser tab is no longer available.')));
  for (let sample = 0; sample < AGENT_FOLLOW_TRIES + 3; sample++) {
    follow.observe(agent('p2'), strip('p1', 'p1', 'p2'));
    await settled();
  }
  assert.equal(picked.length, AGENT_FOLLOW_TRIES);
});

test('a synchronous failure is retried too', async () => {
  const { follow, picked } = setup((count) => {
    if (count === 1) throw new Error('bridge unavailable');
  });
  follow.observe(agent('p2'), strip('p1', 'p1', 'p2'));
  await settled();
  follow.observe(agent('p2'), strip('p1', 'p1', 'p2'));
  assert.equal(picked.length, 2);
});

test('a new turn on the same page follows again after failures were exhausted', async () => {
  const { follow, picked } = setup(() => Promise.reject(new Error('failed')));
  for (let sample = 0; sample < AGENT_FOLLOW_TRIES + 1; sample++) {
    follow.observe(agent('p2', 1), strip('p1', 'p1', 'p2'));
    await settled();
  }
  assert.equal(picked.length, AGENT_FOLLOW_TRIES);
  follow.observe(agent('p2', 2), strip('p1', 'p1', 'p2'));
  assert.equal(picked.length, AGENT_FOLLOW_TRIES + 1);
});

test('a new turn on the same page re-follows when the earlier selection never took hold', async () => {
  const { follow, picked } = setup();
  follow.observe(agent('p2', 1), strip('p1', 'p1', 'p2'));
  await settled();
  follow.observe(agent('p2', 1), strip('p1', 'p1', 'p2'));
  assert.equal(picked.length, 1);
  follow.observe(agent('p2', 2), strip('p1', 'p1', 'p2'));
  assert.deepEqual(picked, [
    ['p2', 'agent'],
    ['p2', 'agent'],
  ]);
});

test('a paused agent page is not followed until the host reports it unpaused', () => {
  const { follow, picked } = setup();
  follow.observe(agent('p2', 1, true), strip('p1', 'p1', 'p2'));
  assert.deepEqual(picked, []);
  follow.observe(agent('p2', 2, false), strip('p1', 'p1', 'p2'));
  assert.deepEqual(picked, [['p2', 'agent']]);
});

test('"보기" selects the agent page even when paused or already shown, and asks the host to resume', () => {
  const { follow, picked } = setup();
  follow.observe(agent('p2', 1, true), strip('p1', 'p1', 'p2'));
  follow.resume();
  assert.deepEqual(picked, [['p2', 'resume']]);
  follow.observe(agent('p2', 1, false), strip('p2', 'p1', 'p2'));
  follow.resume();
  assert.deepEqual(picked, [
    ['p2', 'resume'],
    ['p2', 'resume'],
  ]);
});

test('"보기" pressed before the first sample resumes on the first agent page', () => {
  const { follow, picked } = setup();
  follow.resume();
  follow.observe(undefined, strip('p1', 'p1'));
  assert.deepEqual(picked, []);
  follow.observe(agent('p2', 1, true), strip('p1', 'p1', 'p2'));
  assert.deepEqual(picked, [['p2', 'resume']]);
});

function fakeView(facts) {
  const target = new EventTarget();
  return Object.assign(target, {
    getAgentPage: () => facts.agentPage,
    getTabs: () => facts.tabs,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  });
}

test('after a failure the follower looks again on its own, though no metadata event comes', async () => {
  const facts = { agentPage: agent('p2'), tabs: strip('p1', 'p1', 'p2') };
  const { follow, picked, time } = setup((count) => (count < 3 ? Promise.reject(new Error('busy')) : undefined));
  const detach = follow.attach(fakeView(facts));
  assert.equal(picked.length, 1);
  await settled();
  assert.equal(time.fire(), 1);
  assert.equal(picked.length, 2);
  await settled();
  assert.equal(time.fire(), 1);
  assert.equal(picked.length, 3);
  await settled();
  assert.equal(time.fire(), 0, 'a selection that worked schedules nothing more');
  detach();
});

test('the timer retries stop at the bound and a detached follower runs none', async () => {
  const facts = { agentPage: agent('p2'), tabs: strip('p1', 'p1', 'p2') };
  const { follow, picked, time } = setup(() => Promise.reject(new Error('gone')));
  follow.attach(fakeView(facts));
  for (let round = 0; round < AGENT_FOLLOW_TRIES + 3; round++) {
    await settled();
    time.fire();
  }
  assert.equal(picked.length, AGENT_FOLLOW_TRIES);

  const second = setup(() => Promise.reject(new Error('gone')));
  const detach = second.follow.attach(fakeView(facts));
  await settled();
  detach();
  assert.equal(second.time.fire(), 0);
  assert.equal(second.picked.length, 1);
});

test('a selection that rejects after detach schedules nothing and never selects again', async () => {
  for (const mode of ['agent', 'resume']) {
    const facts = { agentPage: agent('p2', 1, mode === 'resume'), tabs: strip('p1', 'p1', 'p2') };
    let reject;
    const { follow, picked, time } = setup(() => new Promise((_, fail) => (reject = fail)));
    const detach = follow.attach(fakeView(facts));
    if (mode === 'resume') follow.resume();
    assert.equal(picked.length, 1, mode);
    detach();
    reject(new Error('settled after detach'));
    await settled();
    assert.equal(time.fire(), 0, `${mode}: no retry after detach`);
    assert.equal(picked.length, 1, mode);
  }
});

test('a rejection from an earlier attachment does not disturb a newer one', async () => {
  const facts = { agentPage: agent('p2'), tabs: strip('p1', 'p1', 'p2') };
  const rejects = [];
  const { follow, picked, time } = setup(() => new Promise((resolve, fail) => rejects.push({ resolve, fail })));
  const detach = follow.attach(fakeView(facts));
  detach();
  follow.attach(fakeView(facts));
  assert.equal(picked.length, 2);
  rejects[0].fail(new Error('stale'));
  await settled();
  assert.equal(time.fire(), 0, 'the stale rejection scheduled nothing');
  rejects[1].fail(new Error('current'));
  await settled();
  assert.equal(time.fire(), 1, 'the live attachment still retries');
});

test('a failed "보기" is tried again by the timer', async () => {
  const facts = { agentPage: agent('p2', 1, true), tabs: strip('p1', 'p1', 'p2') };
  const { follow, picked, time } = setup((count) => (count === 1 ? Promise.reject(new Error('busy')) : undefined));
  follow.attach(fakeView(facts));
  follow.resume();
  await settled();
  time.fire();
  assert.deepEqual(picked, [
    ['p2', 'resume'],
    ['p2', 'resume'],
  ]);
});

test('with a real page client whose metadata never changes, a rejected select is still retried', async () => {
  const facts = {
    documentId: 'p1:1',
    frameId: 'p1:1',
    webContentsId: 1,
    url: 'https://example.test',
    title: 'Page',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    width: 800,
    height: 600,
    viewportWidth: 800,
    viewportHeight: 600,
    tabs: strip('p1', 'p1', 'p2'),
    agentPage: agent('p2'),
  };
  const sent = [];
  const events = [];
  const { createBrowserPageClient } = await import('./browser-page-client.ts');
  const client = createBrowserPageClient({
    sessionId: 's',
    update() {},
    updateMetadata() {},
    failure() {},
    api: {
      browserPageMetadata: async () => facts,
      browserPageControl: async (_session, action) => {
        sent.push(action);
        if (sent.length === 1) throw new Error('Browser tab is no longer available in this session.');
        return undefined;
      },
    },
  });
  const node = new EventTarget();
  client.bind(node, () => {});
  const time = clock();
  const follow = createBrowserAgentFollow((id, mode) => node.selectTab(id, mode), time.later);
  node.addEventListener('agent-page', () => events.push('agent-page'));
  follow.attach(node);
  await client.pollMetadata();
  await settled();
  assert.deepEqual(events, ['agent-page']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].follow, 'agent');
  // The same facts again: the client emits nothing, yet the retry happens.
  await client.pollMetadata();
  await settled();
  assert.deepEqual(events, ['agent-page']);
  assert.equal(time.fire(), 1);
  await settled();
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1].type, sent[1].tabId, sent[1].follow], ['select-tab', 'p2', 'agent']);
  client.dispose();
});

test('no agent page leaves the user selection alone', () => {
  const { follow, picked } = setup();
  follow.observe(undefined, strip('p1', 'p1', 'p2'));
  follow.resume();
  assert.deepEqual(picked, []);
});
