// The host side of "대표 에이전트 먼저": the once-per-profile decision of
// whether Mixy exists (existing users are never blocked), and the one greeting
// of each agent a chat's setup tool creates.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentGreetingsFileStore, createAgentGreetings, resolveMixyCreated } from './mixy-first.ts';

const contact = (id, extra = {}) => ({ id, custom: true, label: id, description: `${id} job`, ...extra });

function statusHost({ status = { created: null }, sessions = [], agents = [] } = {}) {
  const marks = [];
  return {
    marks,
    deps: {
      status,
      listAgents: async () => agents,
      sessionIds: async () => sessions,
      setCreated: async (value) => {
        marks.push(value);
      },
    },
  };
}

test('migration: a profile with a Mixy thread, any session or any contact agent counts as having Mixy', async () => {
  for (const host of [
    statusHost({ sessions: ['sess_home_lead'] }),
    statusHost({ sessions: ['sess_work_1'] }),
    statusHost({ agents: [{ id: 'maintainer', locked: true }, contact('github-watcher')] }),
    // A switched-off agent still means the user had agents.
    statusHost({ agents: [contact('off', { disabled: true })], sessions: ['sess_home_off'] }),
  ]) {
    assert.equal(await resolveMixyCreated(host.deps), true);
    assert.deepEqual(host.marks, [true], 'the decision is persisted');
  }
});

test('migration: only a fresh profile with no agents and no sessions sees the empty state', async () => {
  const host = statusHost({ agents: [{ id: 'maintainer', locked: true }] });
  assert.equal(await resolveMixyCreated(host.deps), false);
  assert.deepEqual(host.marks, [false]);
});

test('a decided profile keeps its decision: sessions made before Mixy never create it', async () => {
  const fresh = statusHost({ status: { created: false }, sessions: ['sess_work_1'], agents: [contact('a')] });
  assert.equal(await resolveMixyCreated(fresh.deps), false);
  const created = statusHost({ status: { created: true } });
  assert.equal(await resolveMixyCreated(created.deps), true);
  assert.deepEqual([...fresh.marks, ...created.marks], [], 'nothing is rewritten');
});

function greetingsHost(initial = null, catalog = []) {
  let stored = initial;
  const greeted = [];
  const greetings = createAgentGreetings({
    read: async () => stored,
    write: async (ids) => {
      stored = [...ids];
    },
    listAgents: async () => catalog,
    greet: async (agent) => {
      greeted.push(agent);
    },
  });
  return { greetings, greeted, stored: () => stored };
}

test('the first catalog read records the existing agents without greeting them', async () => {
  const host = greetingsHost(null, [contact('a'), contact('b')]);
  await host.greetings.reconcile([contact('a'), contact('b')]);
  assert.deepEqual(host.greeted, []);
  assert.deepEqual(host.stored(), ['a', 'b']);
});

test('an agent created through Mixy chat greets once; reads after it never re-greet', async () => {
  const host = greetingsHost(['a']);
  const catalog = [{ id: 'maintainer', locked: true }, contact('a'), contact('pr-watch', { label: 'PR 감시' })];
  await Promise.all([host.greetings.reconcile(catalog), host.greetings.reconcile(catalog)]);
  await host.greetings.reconcile(catalog);
  assert.deepEqual(host.greeted, [{ id: 'pr-watch', name: 'PR 감시', description: 'pr-watch job' }]);
});

test('an agent the dialog created is left to the dialog: the host never greets it', async () => {
  const host = greetingsHost(['a']);
  await host.greetings.noteCreated('made-in-dialog');
  await host.greetings.reconcile([contact('a'), contact('made-in-dialog')]);
  assert.deepEqual(host.greeted, []);
});

test('a switched-off new agent is recorded but not greeted', async () => {
  const host = greetingsHost([]);
  await host.greetings.reconcile([contact('off', { disabled: true })]);
  assert.deepEqual(host.greeted, []);
  assert.deepEqual(host.stored(), ['off']);
});

test('agent-greetings.json round-trips and reads absent as never recorded', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixy-first-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = agentGreetingsFileStore(join(dir, 'agent-greetings.json'));
  assert.equal(await store.read(), null);
  await store.write(['b', 'a', 'b']);
  assert.deepEqual(await store.read(), ['a', 'b']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'agent-greetings.json'), 'utf8')), { seen: ['a', 'b'] });
});
