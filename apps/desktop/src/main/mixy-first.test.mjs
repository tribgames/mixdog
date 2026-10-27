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

// Whether Mixy exists is the runtime's rule (`exists`; its cases run against
// the real runtime in mixy-presence.test.mjs). The host only decides an
// undecided profile once and answers with `exists`.
test('migration: an undecided profile is marked created when it has Mixy’s thread or evidence of her; the answer is `exists`', async () => {
  const host = statusHost({ status: { created: null, exists: true }, sessions: ['sess_work_1', 'sess_home_lead'] });
  assert.equal(await resolveMixyCreated(host.deps), true);
  assert.deepEqual(host.marks, [true], 'the decision is persisted');
  // An empty Mixy thread: persisted as before, but she does not exist (the
  // rule finds no evidence) — the dialog shows.
  const empty = statusHost({ status: { created: null, exists: false }, sessions: ['sess_home_lead'] });
  assert.equal(await resolveMixyCreated(empty.deps), false);
  assert.deepEqual(empty.marks, [true]);
  // Evidence without a thread (a routine of hers that never ran): created.
  const owner = statusHost({ status: { created: null, exists: true }, sessions: ['sess_work_1'] });
  assert.equal(await resolveMixyCreated(owner.deps), true);
  assert.deepEqual(owner.marks, [true]);
});

test('migration: an existing user with sessions or agents but no Mixy thread sees the 대표 에이전트 dialog', async () => {
  for (const host of [
    statusHost({ status: { created: null, exists: false } }),
    statusHost({ status: { created: null, exists: false }, sessions: ['sess_work_1'] }),
    statusHost({ status: { created: null, exists: false }, sessions: ['sess_home_github-watcher'] }),
  ]) {
    assert.equal(await resolveMixyCreated(host.deps), false);
    assert.deepEqual(host.marks, [false]);
  }
});

test('a decided profile keeps its decision and answers with `exists`; nothing is rewritten', async () => {
  for (const [status, expected] of [
    [{ created: false, exists: false }, false],
    [{ created: true, exists: true }, true],
    // v1.3.0's automatic, never-used Mixy: the rule says no.
    [{ created: true, exists: false }, false],
  ]) {
    const host = statusHost({ status, sessions: ['sess_work_1', 'sess_home_lead'] });
    assert.equal(await resolveMixyCreated(host.deps), expected);
    assert.deepEqual(host.marks, []);
  }
});

test('a status whose `exists` could not be read is no answer: it rejects and decides nothing', async () => {
  for (const status of [{ created: null, exists: null }, { created: true }, null]) {
    const host = statusHost({ status, sessions: ['sess_home_lead'] });
    await assert.rejects(resolveMixyCreated(host.deps), /could not be read/);
    assert.deepEqual(host.marks, []);
  }
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
