// Runs every conformance/*.json scenario against the TS engine over the mock transport.
// The Rust runner (native/core/crates/mixdog-app-server-client/tests/conformance.rs) interprets the same files.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import type { ClientErrorDetail, ClientEvent, Json, ProtocolClient, ThreadReducer } from '../src/api.ts';
import { ClientFailure, connect, ladderDelay, uuidv7 } from '../src/engine.ts';
import { MockConn, MockNetwork } from '../src/mock.ts';

const dir = new URL('../conformance/', import.meta.url);
const options = JSON.parse(readFileSync(new URL('options.json', dir), 'utf8'));
type Step = Record<string, any>;

const recorder: ThreadReducer<Json> = {
  initial: (snapshot) => ({ snap: snapshot, log: [] }),
  apply: (state, n) => {
    const s = state as { snap: Json; log: string[] };
    return { snap: s.snap, log: [...s.log, `${n.method}@${n.feed?.seq}`] };
  },
};

const guard = <T>(p: Promise<T>, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error(`timeout: ${what}`)), 2000).unref())]);

function match(expected: any, actual: any, caps: Map<string, unknown>, path: string): void {
  if (typeof expected === 'string' && expected.startsWith('$cap:')) {
    const k = expected.slice(5);
    if (caps.has(k)) assert.deepEqual(actual, caps.get(k), path);
    else caps.set(k, actual);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual) && actual.length === expected.length, `${path}: array ${JSON.stringify(actual)}`);
    expected.forEach((e, i) => match(e, actual[i], caps, `${path}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual), `${path}: object ${JSON.stringify(actual)}`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: keys`);
    for (const k of Object.keys(expected)) match(expected[k], actual[k], caps, `${path}.${k}`);
  } else assert.deepEqual(actual, expected, path);
}
function subst(v: any, caps: Map<string, unknown>): any {
  if (typeof v === 'string' && v.startsWith('$cap:')) {
    assert.ok(caps.has(v.slice(5)), `uncaptured ${v}`);
    return caps.get(v.slice(5));
  }
  if (Array.isArray(v)) return v.map((x) => subst(x, caps));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, caps)]));
  return v;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

async function run(steps: Step[]): Promise<void> {
  const net = new MockNetwork();
  const caps = new Map<string, unknown>();
  const sleeps: number[] = [];
  const statuses: string[] = [];
  const blobFailures: ClientErrorDetail[] = [];
  let statusAt = 0;
  let conn: MockConn | undefined;
  let client: ProtocolClient | undefined;
  let connecting: Promise<ProtocolClient> | undefined;
  let opSeq = 0;
  let handshakes = 0;
  const calls = new Map<string, Promise<unknown>>();

  const startConnect = () => {
    connecting = connect({
      target: { id: 'local' },
      connector: net,
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      threadReducer: recorder,
      clock: { sleep: (ms) => (sleeps.push(ms), Promise.resolve()) },
      random: () => options.jitterUnit,
      newOpId: () => `op-${++opSeq}`,
      ladder: options.ladder,
    });
    connecting.catch(() => {});
  };
  const sent = async (): Promise<any> => JSON.parse(await guard(conn!.nextSent(), 'client frame'));

  for (const s of steps) {
    switch (s.do) {
      case 'connect':
        startConnect();
        break;
      case 'handshake': {
        conn = await guard(net.accept(), 'accept');
        const init = await sent();
        match({ id: `$cap:init${++handshakes}`, method: 'initialize', params: { clientInfo: options.clientInfo, capabilities: options.capabilities } }, init, caps, 'initialize');
        if (s.refuse) {
          conn.serverSend({ id: init.id, error: { code: -32600, message: 'v', data: { reason: s.refuse, serverVersion: '2.0.0', clientVersion: '1.4.6' } } });
          conn.serverClose(4002, 'version');
          break;
        }
        const template = options.initializeResult;
        conn.serverSend({ id: init.id, result: { ...template, serverInstanceId: s.instance, limits: { ...template.limits, ...(s.limits ?? {}) } } });
        match({ method: 'initialized' }, await sent(), caps, 'initialized');
        break;
      }
      case 'connected': {
        if (s.error) {
          const e = await guard(connecting!.then(() => undefined, (x) => x), 'connect').then((x) => x as ClientFailure);
          assert.equal(e.detail.kind, s.error);
          break;
        }
        client = await guard(connecting!, 'connect');
        assert.equal(client.server.serverInstanceId, s.instance);
        statuses.push('ready');
        client.on((e: ClientEvent) => {
          if (e.type === 'status') statuses.push(e.status.state === 'reconnecting' ? `reconnecting:${e.status.attempt}` : e.status.state);
          if (e.type === 'blobUnavailable') blobFailures.push(e.error);
        });
        break;
      }
      case 'expectSend':
        match(s.frame, await sent(), caps, 'frame');
        break;
      case 'expectNoSend':
        await settle();
        assert.equal(conn!.sent.length, 0, `unexpected frame ${conn!.sent[0]}`);
        break;
      case 'serverSend':
        conn!.serverSend(subst(s.frame, caps));
        break;
      case 'serverSendRaw':
        conn!.serverSendRaw(s.text);
        break;
      case 'serverClose':
        conn!.serverClose(s.code, s.reason ?? '');
        break;
      case 'expectClientClose':
        await settle();
        assert.equal(conn!.clientClose?.code, s.none ? undefined : s.code);
        break;
      case 'openFails':
        net.failNext = s.count;
        break;
      case 'call': {
        const c = client!;
        let p: Promise<unknown>;
        switch (s.fn ?? 'call') {
          case 'call': p = c.call(s.method, s.params); break;
          case 'resumeThread': p = c.resumeThread(s.threadId, s.window); break;
          case 'unsubscribeThread': p = c.unsubscribeThread(s.threadId).then(() => null); break;
          case 'subscribeApp': p = c.subscribeApp().then(() => null); break;
          case 'putBlob': p = c.putBlob(new TextEncoder().encode(s.text), s.mediaType); break;
          case 'readBlob': p = c.readBlob({ blob: { digest: s.digest, bytes: s.bytes, mediaType: s.mediaType } }).then((b) => new TextDecoder().decode(b)); break;
          default: throw new Error(`fn ${s.fn}`);
        }
        calls.set(s.as, p.then((v) => ({ ok: v }), (e) => ({ err: e })));
        break;
      }
      case 'result': {
        const r: any = await guard(calls.get(s.as)!, `result ${s.as}`);
        if (s.error) {
          assert.ok(r.err instanceof ClientFailure, `expected error, got ${JSON.stringify(r)}`);
          assert.equal(r.err.detail.kind, s.error.kind);
          if (s.error.reason) assert.equal(r.err.detail.reason, s.error.reason);
          if (s.error.digest) assert.equal(r.err.detail.digest, s.error.digest);
          if (s.error.cause) assert.equal((r.err.detail as { cause?: { kind: string } }).cause?.kind, s.error.cause.kind);
        } else {
          assert.ok(!r.err, `unexpected error ${r.err}`);
          assert.deepEqual(r.ok, s.ok);
        }
        break;
      }
      case 'notify':
        client!.notify(s.method, s.params);
        break;
      case 'respond':
        client!.respond(s.id, s.answer);
        break;
      case 'close':
        await client!.close();
        break;
      case 'settle':
        await settle();
        break;
      case 'expectSleeps':
        await settle();
        assert.deepEqual(sleeps.splice(0), s.ms);
        break;
      case 'expectStatus':
        await settle();
        assert.deepEqual(statuses.slice(statusAt, statusAt + s.states.length), s.states);
        statusAt += s.states.length;
        break;
      case 'expectBlobUnavailable':
        await settle();
        assert.deepEqual(blobFailures.splice(0).map((d) => ({ kind: d.kind, digest: (d as { digest?: string }).digest })), s.errors);
        break;
      case 'expectFeed':
        assert.deepEqual(client!.store.thread(s.id)?.feed, { id: s.id, epoch: s.epoch, seq: s.seq });
        break;
      case 'expectThreadState':
        assert.deepEqual(client!.store.thread(s.thread)?.state, s.state);
        break;
      case 'expectNoThread':
        assert.equal(client!.store.thread(s.thread), undefined);
        break;
      case 'expectSection': {
        const e = client!.store.section(s.section, s.key);
        if (s.absent) assert.equal(e, undefined);
        else assert.deepEqual(e && { revision: e.revision, value: e.value }, { revision: s.revision, value: s.value });
        break;
      }
      case 'expectServerRequests':
        assert.deepEqual(client!.pendingServerRequests().map((r) => r.id), s.ids);
        break;
      default:
        throw new Error(`unknown step ${s.do}`);
    }
  }
}

for (const f of readdirSync(dir).filter((n) => /^\d+_.*\.json$/.test(n)).sort()) {
  const sc = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  test(`${f}: ${sc.name}`, () => run(sc.steps));
}

test('ladder: full jitter, doubling to the cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((a) => ladderDelay(a, 0.5)), [125, 250, 500, 1000, 2000, 2500, 2500]);
  assert.equal(ladderDelay(3, 0), 0);
});

test('default op ids are UUIDv7', () => {
  assert.match(uuidv7(1762350000000), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
