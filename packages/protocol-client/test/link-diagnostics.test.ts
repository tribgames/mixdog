// The link life-cycle lines the host logs (`ConnectOptions.onDiagnostic`): a drop says what it cost, a reconnect says how many
// subscriptions came back, a violation names a fixed category. Every wait is on the line itself or on the mock transport's own signal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect } from '../src/client.ts';
import { type MockConn, MockNetwork } from '../src/mock.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const attached = { subscription: { epoch: 'e1', startSeq: 1 } };

async function rig(sink?: (event: string, fields: Record<string, unknown>) => void) {
  const net = new MockNetwork();
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const waiting = new Map<string, Array<() => void>>();
  const diagnostic = (event: string, fields: Record<string, unknown>): void => {
    lines.push({ event, fields });
    for (const resolve of waiting.get(event)?.splice(0) ?? []) resolve();
    sink?.(event, fields);
  };
  /** Resolves when the next line of `event` is written. */
  const line = (event: string): Promise<void> =>
    new Promise((resolve) => waiting.set(event, [...(waiting.get(event) ?? []), resolve]));
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    clock: { sleep: () => Promise.resolve() },
    random: () => options.jitterUnit,
    ladder: options.ladder,
    onDiagnostic: diagnostic,
  });
  const handshake = async (): Promise<MockConn> => {
    const conn = await net.accept();
    const init = JSON.parse(await conn.nextSent());
    conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 'i1' } });
    await conn.nextSent();
    return conn;
  };
  const conn = await handshake();
  return {
    client: await connecting,
    conn,
    handshake,
    lines,
    line,
    of: (event: string) => lines.filter((l) => l.event === event),
  };
}

test('a dropped link is logged with what it held, and the reconnect with how many subscriptions it restored', async () => {
  const { client, conn: first, handshake, lines, line, of } = await rig();
  assert.deepEqual(
    lines.map((l) => l.event),
    ['link-open']
  );

  const resumed = client.resumeThread('t1', { lastItems: 5 });
  const resume = JSON.parse(await first.nextSent());
  first.serverSend({ id: resume.id, result: attached });
  await resumed;

  const down = line('link-down');
  first.serverClose(1006);
  await down;
  assert.equal(of('link-down')[0]!.fields.threadsFollowed, 1);
  assert.equal(of('link-down')[0]!.fields.ownerClosed, false);

  const reconnected = line('link-reconnected');
  const settled = line('link-restore-settled');
  const second = await handshake();
  await reconnected;
  assert.equal(of('link-reconnected')[0]!.fields.threadsToRestore, 1);
  const again = JSON.parse(await second.nextSent());
  assert.equal(again.method, 'thread/resume');
  second.serverSend({ id: again.id, result: attached });
  await settled;
  assert.equal(of('link-restore-settled')[0]!.fields.threadsRestored, 1);
  assert.equal(of('link-restore-settled')[0]!.fields.threadsLost, 0);
  await client.close();
});

test('a restore that settles after the link dropped again names the connection that started it', async () => {
  const { client, conn: first, handshake, line, of } = await rig();
  const resumed = client.resumeThread('t1', { lastItems: 5 });
  const resume = JSON.parse(await first.nextSent());
  first.serverSend({ id: resume.id, result: attached });
  await resumed;
  first.serverClose(1006);

  const reconnected = line('link-reconnected');
  const second = await handshake();
  await reconnected;
  await second.nextSent(); // the restore's request is on the wire, unanswered
  const settled = line('link-restore-settled');
  second.serverClose(1006); // the link drops under it, and the ladder opens the next connection
  await handshake();
  await settled;
  assert.equal(
    of('link-restore-settled')[0]!.fields.linkSeq,
    of('link-reconnected')[0]!.fields.linkSeq,
    'the restore belongs to the connection that was reconnected'
  );
  assert.equal(of('link-restore-settled')[0]!.fields.threadsFailed, 1);
  await client.close();
});

test('a protocol violation is logged under a fixed category, never with the feed id or exception text of what failed', async () => {
  const { client, conn, line, of } = await rig();
  const resumed = client.resumeThread('secret-feed-id', { lastItems: 5 });
  const resume = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: resume.id, result: attached });
  await resumed;
  const violation = line('link-violation');
  conn.serverSend({
    method: 'thread/runtime/updated',
    params: {},
    feed: { id: 'secret-feed-id', epoch: 'e1', seq: 9 },
  });
  await violation;
  assert.equal(of('link-violation')[0]!.fields.category, 'feed gap');
  const { feedKind, method, hadPosition, epochChanged, expectedSeq, receivedSeq } = of('link-violation')[0]!.fields;
  assert.deepEqual(
    { feedKind, method, hadPosition, epochChanged, expectedSeq, receivedSeq },
    {
      feedKind: 'thread',
      method: 'thread/runtime/updated',
      hadPosition: true,
      epochChanged: false,
      expectedSeq: 1,
      receivedSeq: 9,
    },
    'what identifies the gap: the kind of feed, the notification, the positions'
  );
  assert.equal(JSON.stringify(of('link-violation')).includes('secret-feed-id'), false);
  await client.close();
});

test("a gap on a notification the method table does not list logs the method as unknown, never the peer's text", async () => {
  const { client, conn, line, of } = await rig();
  const resumed = client.resumeThread('t1', { lastItems: 5 });
  conn.serverSend({ id: JSON.parse(await conn.nextSent()).id, result: attached });
  await resumed;
  const violation = line('link-violation');
  conn.serverSend({ method: 'x/secret-content', params: {}, feed: { id: 't1', epoch: 'e1', seq: 4 } });
  await violation;
  assert.equal(of('link-violation')[0]!.fields.method, 'unknown');
  assert.equal(JSON.stringify(of('link-violation')).includes('secret-content'), false);
  await client.close();
});

test('a diagnostics sink that throws changes nothing the link does', async () => {
  let armed = false;
  const {
    client,
    conn: first,
    handshake,
  } = await rig(() => {
    if (armed) throw new Error('the sink failed');
  });
  armed = true;
  const resumed = client.resumeThread('t1', { lastItems: 5 });
  const resume = JSON.parse(await first.nextSent());
  first.serverSend({ id: resume.id, result: attached });
  await resumed;
  const up = new Promise<void>((resolve) => {
    const off = client.on((event) => {
      if (event.type === 'status' && event.status.state === 'ready') {
        off();
        resolve();
      }
    });
  });
  first.serverClose(1006);
  const second = await handshake();
  await up;
  assert.equal(JSON.parse(await second.nextSent()).method, 'thread/resume', 'the subscription is still restored');
  await client.close();
});
