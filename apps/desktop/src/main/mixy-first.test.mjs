// The host side of "대표 에이전트 먼저": the once-per-profile decision of
// whether Mixy exists (existing users are never blocked), and the one greeting
// of each agent a chat's setup tool creates.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentGreetingsFileStore, createAgentGreetings, resolveMixyCreated } from './mixy-first.ts';

// A bot as listAgents reports it: every bot creation path writes `kind: bot`.
const contact = (id, extra = {}) => ({
  id,
  custom: true,
  kind: 'bot',
  label: id,
  description: `${id} job`,
  route: { provider: 'openai', model: 'gpt-test' },
  ...extra,
});

// `agents` in a call only documents the profile: the decision never reads them.
function statusHost({ status = { created: null }, sessions = [] } = {}) {
  const marks = [];
  return {
    marks,
    deps: {
      status,
      sessionIds: async () => sessions,
      setCreated: async (value) => {
        marks.push(value);
      },
    },
  };
}

test('migration: only a profile that already has Mixy’s thread, with a conversation in it, counts as having Mixy', async () => {
  const host = statusHost({
    status: { created: null, homeChatted: true },
    sessions: ['sess_work_1', 'sess_home_lead'],
  });
  assert.equal(await resolveMixyCreated(host.deps), true);
  assert.deepEqual(host.marks, [true], 'the decision is persisted');
  // An empty Mixy thread: persisted as before, but read as the next read
  // reads it (unnamed and never talked to) — the dialog shows.
  const empty = statusHost({ status: { created: null, homeChatted: false }, sessions: ['sess_home_lead'] });
  assert.equal(await resolveMixyCreated(empty.deps), false);
  assert.deepEqual(empty.marks, [true]);
});

test('migration: an existing user with sessions or agents but no Mixy thread sees the 대표 에이전트 dialog', async () => {
  for (const host of [
    statusHost(),
    statusHost({ sessions: ['sess_work_1'] }),
    statusHost({ agents: [contact('github-watcher')], sessions: ['sess_home_github-watcher'] }),
  ]) {
    assert.equal(await resolveMixyCreated(host.deps), false);
    assert.deepEqual(host.marks, [false]);
  }
});

test('a decided profile keeps its decision: sessions made before Mixy never create it', async () => {
  const fresh = statusHost({ status: { created: false }, sessions: ['sess_work_1'], agents: [contact('a')] });
  assert.equal(await resolveMixyCreated(fresh.deps), false);
  const created = statusHost({ status: { created: true, name: 'Mixy', homeChatted: false } });
  assert.equal(await resolveMixyCreated(created.deps), true);
  assert.deepEqual([...fresh.marks, ...created.marks], [], 'nothing is rewritten');
});

test('upgrade populations: an unused 1.3.0 automatic Mixy shows the dialog; a used, renamed or dialog-made Mixy stays', async () => {
  // A: ≤1.2.6 → 1.3.1, sessions and old agents but no Mixy thread: the dialog shows.
  const a = statusHost({ sessions: ['sess_work_1', 'sess_work_2'], agents: [{ id: 'db-expert', custom: true }] });
  assert.equal(await resolveMixyCreated(a.deps), false);
  assert.deepEqual(a.marks, [false]);
  // B: 1.3.0 auto-created Mixy ({"created": true}), never named:
  //  - its thread missing or with no conversation → the dialog shows;
  for (const sessions of [['sess_work_1'], ['sess_work_1', 'sess_home_lead']]) {
    const b = statusHost({ status: { created: true, name: '', homeChatted: false }, sessions });
    assert.equal(await resolveMixyCreated(b.deps), false);
    assert.deepEqual(b.marks, [], 'never rewritten');
  }
  //  - the user chatted with it (any message) → kept, still unnamed;
  const chatted = statusHost({ status: { created: true, name: '', homeChatted: true }, sessions: ['sess_home_lead'] });
  assert.equal(await resolveMixyCreated(chatted.deps), true);
  //  - the user renamed it in its profile → kept.
  const renamed = statusHost({ status: { created: true, name: 'Buddy', homeChatted: false } });
  assert.equal(await resolveMixyCreated(renamed.deps), true);
  // C: fresh 1.3.0 that made Mixy in the dialog (always names it), greeting or not.
  for (const homeChatted of [true, false]) {
    const c = statusHost({ status: { created: true, name: 'Mixy', homeChatted }, sessions: ['sess_home_lead'] });
    assert.equal(await resolveMixyCreated(c.deps), true);
    assert.deepEqual(c.marks, []);
  }
  assert.deepEqual([...chatted.marks, ...renamed.marks], []);
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

test('a new workflow agent (unmarked or kind: agent) is recorded but never greeted: only bots greet', async () => {
  const host = greetingsHost(['a']);
  const catalog = [contact('a'), { id: 'legacy', custom: true, label: 'Legacy' }, contact('triage', { kind: 'agent' })];
  await host.greetings.reconcile(catalog);
  assert.deepEqual(host.greeted, []);
  assert.deepEqual(host.stored(), ['a', 'legacy', 'triage']);
});

test('a new agent without a model is recorded but not greeted: its greeting turn would only fail', async () => {
  const host = greetingsHost(['a']);
  await host.greetings.reconcile([contact('a'), contact('no-model', { route: null })]);
  assert.deepEqual(host.greeted, []);
  assert.deepEqual(host.stored(), ['a', 'no-model']);
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

test('a NUL-filled agent-greetings.json reads as never recorded, so the existing agents are recorded, not greeted', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixy-first-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'agent-greetings.json');
  writeFileSync(file, Buffer.alloc(80));
  const store = agentGreetingsFileStore(file);
  assert.equal(await store.read(), null);
  await store.write(['a']);
  assert.deepEqual(await store.read(), ['a']);
});
