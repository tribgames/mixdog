// The app snapshot folds in bounded turns and swaps in whole; subscription restore/loss reaches store listeners.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { StoreChange } from '../src/api.ts';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';
import { FakeTurn, UNITS_PER_TURN } from './fake-turn.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const tick = () => new Promise<void>((r) => setImmediate(r));

async function setup(turn?: FakeTurn) {
  const net = new MockNetwork();
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
    ...(turn ? { turn: turn.options } : {}),
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  const client = await connecting;
  const app = client.subscribeApp();
  const sub = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: sub.id, result: { subscription: { id: 'as', mode: 'snapshot', epoch: 'ae', startSeq: 1 } } });
  await app;
  const changes: StoreChange[] = [];
  client.store.subscribe((c) => changes.push(c));
  return { net, conn, client, changes };
}
const section = (name: string, key: string | null, revision: number, value: unknown) => ({ section: name, key, revision, value });
const snapshot = (sections: unknown[], seq: number) => ({ method: 'app/snapshot', params: { sections }, feed: { id: 'app', epoch: 'ae', seq } });

test('a 1 MB app snapshot folds in bounded turns, swaps in whole, and announces what it removed', async () => {
  const turn = new FakeTurn();
  const { conn, client, changes } = await setup(turn);
  conn.serverSend(snapshot([section('ports', null, 1, [1]), section('notice', 'x', 1, 'old'), section('update', 'k', 1, 'old')], 0));
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(changes.at(-1), { type: 'appSnapshot' });
  changes.length = 0;

  // ~1.1 MB: 2400 keyed sections of ~460 bytes each, plus the sections that survive.
  const filler = 'x'.repeat(380);
  const big = [section('ports', null, 2, [2]), section('update', 'k', 2, 'new')];
  for (let i = 0; i < 2400; i++) big.push(section('agents', `k${i}`, 1, { id: i, filler, tags: ['a', 'b', 'c'] }));
  const frame = JSON.stringify(snapshot(big, 1));
  assert.ok(frame.length > 1_000_000);

  // Deterministic turns: see fake-turn.ts. Staging is every turn before the first announced section; announcing counts its own units.
  turn.reset();
  let stagingYields = -1;
  let done = false;
  const seenWhole: number[] = [];
  client.store.subscribe((c) => {
    if (c.type === 'section') {
      if (stagingYields < 0) stagingYields = turn.yields;
      turn.work();
    } else if (c.type === 'appSnapshot') {
      seenWhole.push(client.store.sections('agents').length);
      done = true;
    }
    // A half-folded store would show some of the new sections, or the old section that the snapshot removes.
    const n = client.store.sections('agents').length;
    if (n !== 0 && n !== 2400) assert.fail('half-folded store visible');
  });
  conn.serverSendRaw(frame);
  while (!done) await tick();

  assert.deepEqual(seenWhole, [2400]);
  // Staging: one budget check per section (plus one per 64 nodes), each a unit of fake time, so it must have yielded about
  // once per BUDGET units; a fold that forgot its checks would yield never.
  assert.ok(stagingYields >= Math.floor(2400 / (UNITS_PER_TURN + 1)), `staging yielded ${stagingYields} times`);
  // Announcing: no turn holds more than the budget plus the one step that found it spent.
  const announced = turn.all();
  assert.ok(Math.max(...announced) <= UNITS_PER_TURN, `announced ${Math.max(...announced)} changes in one turn`);
  assert.ok(announced.filter((u) => u > 0).length >= Math.floor(2403 / UNITS_PER_TURN), 'announcements spread over many turns');
  assert.equal(client.store.section('notice', 'x'), undefined);
  assert.equal(client.store.section('update', 'k')?.value, 'new');
  const names = changes.filter((c) => c.type === 'section').map((c) => `${(c as { section: string }).section}/${(c as { key: string | null }).key}`);
  assert.ok(names.includes('notice/x'), 'removed section announced');
  assert.equal(names.length, 2400 + 2 + 1);
  assert.deepEqual(changes.at(-1), { type: 'appSnapshot' });
});

test('a connection that ends mid-fold discards the staging: the store keeps the previous app state', async () => {
  const { conn, client, changes } = await setup();
  conn.serverSend(snapshot([section('ports', null, 1, 'old')], 0));
  for (let i = 0; i < 5; i++) await tick();
  changes.length = 0;
  const many = Array.from({ length: 4000 }, (_, i) => section('agents', `k${i}`, 1, { filler: 'y'.repeat(300), i }));
  conn.serverSend(snapshot([section('ports', null, 2, 'new'), ...many], 1));
  conn.serverClose(1006);
  for (let i = 0; i < 40; i++) await tick();
  assert.equal(client.store.section('ports')?.value, 'old');
  assert.equal(changes.some((c) => c.type === 'appSnapshot'), false);
});

test('restoring or losing a subscription after a reconnect is a store change', async () => {
  const { net, conn, client, changes } = await setup();
  const resumed = client.resumeThread('t1', { lastItems: 10 });
  const req = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: req.id, result: { thread: { id: 't1' }, subscription: { id: 's', mode: 'snapshot', epoch: 'e1', startSeq: 1 } } });
  await resumed;
  conn.serverClose(1006);
  const again = await net.accept();
  const init = JSON.parse(await again.nextSent());
  again.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await again.nextSent();
  for (let i = 0; i < 2; i++) {
    const r = JSON.parse(await again.nextSent());
    if (r.method === 'thread/resume') again.serverSend({ id: r.id, error: { code: -32004, message: 'notice', data: { reason: 'threadNotFound' } } });
    else again.serverSend({ id: r.id, result: { subscription: { id: 'as2', mode: 'snapshot', epoch: 'ae', startSeq: 1 } } });
  }
  for (let i = 0; i < 10; i++) await tick();
  const subs = changes.filter((c) => c.type === 'subscription');
  assert.deepEqual(subs.map((c) => `${(c as { feedId: string }).feedId}:${(c as { state: string }).state}`).sort(), ['app:restored', 't1:lost']);
  assert.equal((subs.find((c) => (c as { state: string }).state === 'lost') as { error: { kind: string } }).error.kind, 'rpc');
  assert.equal(client.store.thread('t1'), undefined);
});

test('a disconnect during the announcements: the reconnect completes them, ahead of anything newer', async () => {
  const turn = new FakeTurn();
  const { net, conn, client, changes } = await setup(turn);
  conn.serverSend(snapshot([section('ports', null, 1, [1]), section('notice', 'x', 1, 'old')], 0));
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(changes.at(-1), { type: 'appSnapshot' });
  changes.length = 0;

  const sections = [section('ports', null, 2, [2])];
  for (let i = 0; i < 300; i++) sections.push(section('agents', `k${i}`, 1, { i }));
  let announced = 0;
  client.store.subscribe((c) => {
    if (c.type === 'section' && ++announced === 50) conn.serverClose(1006); // the connection ends mid-announcement
  });
  conn.serverSend(snapshot(sections, 1));
  for (let i = 0; i < 60; i++) await tick();
  assert.ok(announced >= 50 && announced < 301, `announced ${announced} before the disconnect took effect`);
  assert.equal(changes.some((c) => c.type === 'appSnapshot'), false, 'the abandoned announcement did not complete');

  // Reconnect. The store holds the snapshot, so the cursor is its own: the resume asks for what is newer than it.
  const again = await net.accept();
  const init = JSON.parse(await again.nextSent());
  again.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await again.nextSent();
  const resume = JSON.parse(await again.nextSent());
  assert.equal(resume.method, 'app/subscribe');
  assert.equal(resume.params.resumeFrom.seq, 1);
  again.serverSend({ id: resume.id, result: { subscription: { id: 'as2', mode: 'resume', epoch: 'ae', startSeq: 2 } } });
  // A newer notification right behind the response must come after the owed announcements.
  again.serverSend({ method: 'config/updated', params: section('config', null, 1, 'newer'), feed: { id: 'app', epoch: 'ae', seq: 2 } });
  for (let i = 0; i < 100; i++) await tick();

  const names = changes.filter((c) => c.type === 'section').map((c) => `${(c as { section: string }).section}/${(c as { key: string | null }).key}`);
  const owedSet = ['notice/x', 'ports/null', ...sections.slice(1).map((s) => `agents/${s.key}`)];
  for (const n of owedSet) assert.ok(names.includes(n), `${n} announced`);
  const snapshotAt = changes.findIndex((c) => c.type === 'appSnapshot');
  assert.ok(snapshotAt > 0, 'appSnapshot reached listeners');
  assert.equal(changes.filter((c) => c.type === 'appSnapshot').length, 1);
  const newerAt = changes.findIndex((c) => c.type === 'section' && (c as { section: string }).section === 'config');
  assert.ok(newerAt > snapshotAt, 'the newer notification came after the completed announcements');
  assert.equal(client.store.section('config')?.value, 'newer');
});

test('what a resumed app subscription replays from the time away is not live; what follows its liveSeq is', async () => {
  const { net, conn, client, changes } = await setup();
  conn.serverSend(snapshot([section('notice', 'a', 1, 'standing')], 0));
  for (let i = 0; i < 5; i++) await tick();
  const live: Array<[string | null, boolean]> = [];
  client.store.subscribe((c) => {
    if (c.type === 'section' && c.section === 'notice') live.push([c.key, client.store.appLive()]);
  });
  conn.serverSend({ method: 'notice/updated', params: section('notice', 'b', 1, 'raised'), feed: { id: 'app', epoch: 'ae', seq: 1 } });
  for (let i = 0; i < 5; i++) await tick();
  conn.serverClose(1006);
  const again = await net.accept();
  const init = JSON.parse(await again.nextSent());
  again.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await again.nextSent();
  const resume = JSON.parse(await again.nextSent());
  assert.equal(resume.params.resumeFrom.seq, 1);
  // Seqs 2 and 3 were published while the client was away; 4 is the first after the resumed attach.
  again.serverSend({ id: resume.id, result: { subscription: { id: 'as2', mode: 'replay', epoch: 'ae', startSeq: 2, liveSeq: 4 } } });
  again.serverSend({ method: 'notice/updated', params: section('notice', 'c', 1, 'away'), feed: { id: 'app', epoch: 'ae', seq: 2 } });
  again.serverSend({ method: 'notice/updated', params: section('notice', 'd', 1, 'away'), feed: { id: 'app', epoch: 'ae', seq: 3 } });
  again.serverSend({ method: 'notice/updated', params: section('notice', 'e', 1, 'back'), feed: { id: 'app', epoch: 'ae', seq: 4 } });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(live, [['b', true], ['c', false], ['d', false], ['e', true]]);
  assert.ok(changes.length > 0);
});

test('scanning the old store and resolving a deep value are budgeted too', async () => {
  const turn = new FakeTurn();
  const { conn, client } = await setup(turn);
  // 5000 entries already held and all kept: the swap announces nothing for them but must still look at each.
  const held = Array.from({ length: 5000 }, (_, i) => section('agents', `k${i}`, 1, i));
  let first = false;
  client.store.subscribe((c) => void (first ||= c.type === 'appSnapshot'));
  conn.serverSend(snapshot(held, 0));
  while (!first) await tick();
  turn.reset();
  let atFirst = -1;
  let done = false;
  client.store.subscribe((c) => {
    if (c.type === 'section' && atFirst < 0) atFirst = turn.yields;
    if (c.type === 'appSnapshot') done = true;
  });
  // The new snapshot keeps the 5000 and adds one section holding 20000 numbers.
  conn.serverSend(snapshot([...held.map((s) => ({ ...s, revision: 2 })), section('config', null, 1, Array.from({ length: 20000 }, (_, i) => i))], 1));
  while (!done) await tick();
  // staging: 5000 sections (one check each) + 20000/64 checks for the array; scan: 5000 steps. Each unit of fake time is a step,
  // so neither may pass without yielding about once per UNITS_PER_TURN of them.
  const units = 5000 + Math.floor(20000 / 64) + 5000;
  assert.ok(atFirst >= Math.floor(units / (UNITS_PER_TURN + 1)), `${atFirst} yields before the first announcement`);
});

