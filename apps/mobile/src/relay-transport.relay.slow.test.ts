// Slow: the relay's 45 s offline window runs.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { TransportSink, TransportWriter } from '../../../packages/protocol-client/src/index.ts';
import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
  type RelayE2EEChallenge,
  type RelayE2EEChannel,
  type RelayE2EEServerIdentity,
} from '../../desktop/src/shared/remote-e2ee.ts';
import { terminalOfClose } from './phone-status.ts';
import { createRelayConnector, type CloseInfo, type RelayConnector, type RelaySocket } from './relay-connector.ts';
import { nodeRelayPresent, startRelay, type RelayProcess, type RelayRuntime } from './test-support/relay-process.ts';

// The `ws` package without its type declarations (the mobile package does not carry them): the surface used here.
interface WsSocket {
  readonly bufferedAmount: number;
  on(event: 'open', handler: () => void): void;
  on(event: 'message', handler: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', handler: (code: number, reason: Buffer) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}
type WsConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WsSocket;
const WebSocket = createRequire(import.meta.url)('ws') as WsConstructor;

const STEP_LIMIT_MS = 15_000;
/** The relay closes a phone 4002 this long after the desktop leg left (45 s), plus slack. */
const OFFLINE_WINDOW_LIMIT_MS = 75_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `read` gives a value; fails with `what` after `limit`. */
async function until<T>(read: () => T | undefined | null | false, what: string, limit = STEP_LIMIT_MS): Promise<T> {
  const deadline = Date.now() + limit;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly text: string;
  json(): any;
}

function http(
  relay: RelayProcess,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest(
      relay.origin + path,
      {
        method,
        headers: {
          ...(payload === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** The scripted desktop: a `/desktop` leg that answers every `client-open` with a challenge, verifies the hello, sends `e2ee-ready`, and
 *  answers each JSON-RPC request with `{result: {echo: <method>}}`. It records every control frame the relay sent it. */
class DesktopLeg {
  readonly frames: Array<Record<string, any>> = [];
  readonly requests: Array<{ clientId: string; message: any }> = [];
  readonly opened: Array<{ clientId: string; browserClientId?: string }> = [];
  private readonly sessions = new Map<string, { challenge: RelayE2EEChallenge; channel?: RelayE2EEChannel }>();
  private readonly ws: WsSocket;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    relay: RelayProcess,
    private readonly identity: RelayE2EEServerIdentity,
    deviceId: string,
    secret: string
  ) {
    const basic = Buffer.from(`${deviceId}:${secret}`).toString('base64');
    this.ws = new WebSocket(`ws://127.0.0.1:${relay.port}/desktop`, { headers: { Authorization: `Basic ${basic}` } });
    this.ws.on('message', (data) => {
      // Handled in arrival order: the E2EE steps are asynchronous.
      this.queue = this.queue.then(() => this.handle(data.toString('utf8'))).catch(() => undefined);
    });
    this.ws.on('error', () => undefined);
  }

  private async handle(text: string): Promise<void> {
    const frame = JSON.parse(text) as Record<string, any>;
    this.frames.push(frame);
    if (frame.type === 'client-open') {
      this.opened.push({ clientId: frame.clientId, browserClientId: frame.browserClientId });
      const challenge = createRelayE2EEChallenge();
      this.sessions.set(frame.clientId, { challenge });
      this.send({ type: 'frame', clientId: frame.clientId, data: JSON.stringify(challenge) });
      return;
    }
    if (frame.type !== 'frame') return;
    const session = this.sessions.get(frame.clientId);
    if (!session) return;
    const payload = JSON.parse(frame.data);
    if (!session.channel) {
      session.channel = await acceptRelayE2EEClientHello(this.identity, session.challenge, payload);
      await this.toPhone(frame.clientId, {
        type: 'e2ee-ready',
        version: 1,
        ...session.channel.handshakeConfirmation(),
      });
      return;
    }
    const message = await session.channel.decryptJson(payload);
    this.requests.push({ clientId: frame.clientId, message });
    const request = message as { id?: unknown; method?: unknown };
    if (request.id !== undefined && request.method !== undefined) {
      await this.toPhone(frame.clientId, { jsonrpc: '2.0', id: request.id, result: { echo: request.method } });
    }
  }

  private async toPhone(clientId: string, value: unknown): Promise<void> {
    const channel = this.sessions.get(clientId)?.channel;
    if (!channel) throw new Error('no channel for the phone');
    this.send({ type: 'frame', clientId, data: await channel.encryptJson(value) });
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  frame(type: string): Promise<Record<string, any>> {
    return until(() => this.frames.find((frame) => frame.type === type), `a ${type} frame`);
  }

  close(): void {
    this.ws.close(1000, 'test');
  }

  terminate(): void {
    this.ws.terminate();
  }
}

/** A phone socket without the connector: what it received, how it ended. */
class RawPhone {
  readonly texts: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private readonly ws: WsSocket;

  constructor(relay: RelayProcess, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?token=${token}`, { headers: { Origin: relay.origin } });
    this.ws.on('message', (data, isBinary) => {
      if (!isBinary) this.texts.push(data.toString('utf8'));
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString('utf8') };
    });
    this.ws.on('error', () => undefined);
  }

  send(text: string): void {
    this.ws.send(text);
  }

  text(match: string): Promise<string> {
    return until(() => this.texts.find((text) => text === match), `${match} on the phone socket`);
  }

  end(limit = STEP_LIMIT_MS): Promise<{ code: number; reason: string }> {
    return until(() => this.closed, 'the phone socket to close', limit);
  }

  terminate(): void {
    this.ws.terminate();
  }
}

/** The phone's connector over `ws`, with every socket end recorded as the phone's own `closed` hook sees it. */
function phoneConnector(
  relay: RelayProcess,
  identity: RelayE2EEServerIdentity,
  token: () => string,
  sockets: WsSocket[]
) {
  const ends: Array<{ code: number; reason: string; info: CloseInfo }> = [];
  const readies: Array<Readonly<Record<string, unknown>>> = [];
  const stages = { reused: 0 };
  const createSocket = (url: string): RelaySocket => {
    const ws = new WebSocket(url, { headers: { Origin: relay.origin } });
    sockets.push(ws);
    const socket: RelaySocket = {
      binaryType: '',
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    };
    ws.on('open', () => socket.onopen?.());
    ws.on('message', (data, isBinary) => {
      const bytes = new Uint8Array(data);
      socket.onmessage?.({
        data: isBinary
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : data.toString('utf8'),
      });
    });
    ws.on('close', (code, reason) => socket.onclose?.({ code, reason: reason.toString('utf8') }));
    ws.on('error', () => socket.onerror?.());
    return socket;
  };
  const connector: RelayConnector = createRelayConnector({
    pairing: () => relayE2EEPairingMaterial(identity),
    socketUrl: () => `ws://127.0.0.1:${relay.port}/ws?token=${token()}`,
    createSocket,
    closed: (code, reason, info) => ends.push({ code, reason, info }),
    ready: (hello) => readies.push(hello),
    reused: () => {
      stages.reused += 1;
    },
  });
  return { connector, ends, readies, stages };
}

/** A sink that keeps what the phone's client library would receive. */
function recordingSink() {
  const frames: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const sink: TransportSink = {
    frame: (text) => frames.push(text),
    closed: (code, reason) => closes.push({ code, reason }),
  };
  return { sink, frames, closes };
}

const rpc = (id: number, method: string): string => JSON.stringify({ jsonrpc: '2.0', id, method, params: {} });

const runtimes: Array<{ runtime: RelayRuntime; present: boolean }> = [
  { runtime: 'node', present: nodeRelayPresent() },
  { runtime: 'rust', present: true },
];

for (const { runtime, present } of runtimes) {
  test(`the phone transport against the ${runtime} relay`, {
    timeout: 240_000,
    skip: present ? false : `the ${runtime} relay is not in this tree`,
  }, async (t) => {
    const relay = await startRelay(runtime);
    const identity = await generateRelayE2EEServerIdentity();
    const deviceId = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const sharedToken = randomBytes(32).toString('hex');
    const clientId = randomUUID();
    const sockets: WsSocket[] = [];
    const desktops: DesktopLeg[] = [];
    const raws: RawPhone[] = [];
    const connectDesktop = (): DesktopLeg => {
      const leg = new DesktopLeg(relay, identity, deviceId, secret);
      desktops.push(leg);
      return leg;
    };
    t.after(async () => {
      for (const leg of desktops) leg.terminate();
      for (const raw of raws) raw.terminate();
      for (const socket of sockets) socket.terminate();
      await relay.stop();
    });
    const origin = { Origin: relay.origin };

    let desktop = connectDesktop();
    let pairingToken = '';
    const phone = phoneConnector(relay, identity, () => pairingToken, sockets);
    const first = recordingSink();
    const second = recordingSink();
    let writer!: TransportWriter;
    let observer!: RawPhone;

    await t.test('the desktop leg is told what the relay offers', async () => {
      const capabilities = await desktop.frame('relay-capabilities');
      assert.equal(capabilities.type, 'relay-capabilities');
    });

    await t.test('the phone registers with POST /client/register', async () => {
      desktop.send({ type: 'set-client-token', token: sharedToken });
      // The relay takes the token from the leg's frame: the first registrations may precede it.
      const body = { clientId, name: 'Test phone', platform: 'android', browser: 'webview' };
      let reply = await http(relay, 'POST', '/client/register', {
        body,
        headers: { ...origin, Authorization: `Bearer ${sharedToken}` },
      });
      for (let attempt = 0; reply.status !== 200 && attempt < 100; attempt++) {
        await sleep(50);
        reply = await http(relay, 'POST', '/client/register', {
          body,
          headers: { ...origin, Authorization: `Bearer ${sharedToken}` },
        });
      }
      assert.equal(reply.status, 200);
      const answer = reply.json() as { clientId: string; token: string };
      assert.equal(answer.clientId, clientId);
      assert.match(answer.token, /^[0-9a-f]{32,128}$/);
      pairingToken = answer.token;
      // The browser now holds its own credential: registering again with it is a refresh (no new token), another id is refused.
      const again = await http(relay, 'POST', '/client/register', {
        body,
        headers: { ...origin, Authorization: `Bearer ${pairingToken}` },
      });
      assert.equal(again.status, 200);
      assert.deepEqual(again.json(), { clientId });
      const other = await http(relay, 'POST', '/client/register', {
        body: { ...body, clientId: randomUUID() },
        headers: { ...origin, Authorization: `Bearer ${pairingToken}` },
      });
      assert.equal(other.status, 401);
      const stranger = await http(relay, 'POST', '/client/register', {
        body,
        headers: { ...origin, Authorization: `Bearer ${'0'.repeat(64)}` },
      });
      assert.equal(stranger.status, 401);
    });

    await t.test('the handshake completes and a JSON-RPC message goes both ways', async () => {
      const target = { id: deviceId };
      writer = await phone.connector.open(target, first.sink);
      assert.equal(phone.readies.length, 1);
      assert.equal(phone.readies[0]!.type, 'e2ee-ready');
      const opened = desktop.opened.at(-1)!;
      assert.equal(opened.browserClientId, clientId);
      writer.send(rpc(1, 'thread/list'));
      const answered = await until(
        () => first.frames.find((text) => JSON.parse(text).id === 1),
        'the answer to the request'
      );
      assert.deepEqual(JSON.parse(answered), { jsonrpc: '2.0', id: 1, result: { echo: 'thread/list' } });
      assert.equal((desktop.requests.at(-1)!.message as { method: string }).method, 'thread/list');
      assert.deepEqual(first.closes, []);
    });

    await t.test('the pairing shell calls get the 200, 404 and 429 shapes', async () => {
      desktop.send({ type: 'desktop-lanes', pairV2: 1 });
      const lease = `lease-${randomBytes(6).toString('hex')}`;
      desktop.send({ type: 'pair-code-request', lease, name: 'Test PC' });
      const issued = await desktop.frame('pair-code-issued');
      assert.equal(issued.ok, true);
      assert.equal(issued.lease, lease);
      assert.match(issued.code, /^\d{6}$/);

      const resolved = await http(relay, 'POST', '/pair-code/resolve', { body: { code: issued.code } });
      assert.equal(resolved.status, 200);
      assert.equal(resolved.headers['cache-control'], 'no-store');
      const answer = resolved.json() as { deviceId: string; name: string; ticket: string };
      assert.equal(answer.deviceId, deviceId);
      assert.equal(answer.name, 'Test PC');
      assert.match(answer.ticket, /^[0-9a-f]{32}$/);
      const used = await desktop.frame('pair-code-used');
      assert.equal(used.lease, lease);

      // A spent code is unknown, whatever the shape of the next one.
      const spent = await http(relay, 'POST', '/pair-code/resolve', { body: { code: issued.code } });
      assert.equal(spent.status, 404);
      assert.deepEqual(spent.json(), { status: 'invalid-code' });
      const malformed = await http(relay, 'POST', '/pair-code/resolve', { body: { code: 'abc' } });
      assert.equal(malformed.status, 404);

      const support = await http(relay, 'GET', `/pair-code/support?deviceId=${deviceId}`);
      assert.equal(support.status, 200);
      assert.deepEqual(support.json(), { online: true, pairV2: true });
      const unknown = await http(relay, 'GET', `/pair-code/support?deviceId=${randomUUID()}`);
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.json(), { status: 'unknown' });

      const presence = await http(relay, 'POST', '/pair-code/presence', { body: { ids: [deviceId, randomUUID()] } });
      assert.equal(presence.status, 200);
      assert.deepEqual(presence.json(), { online: { [deviceId]: true } });
      const unrouted = await http(relay, 'POST', '/pair-code/nothing', { body: {} });
      assert.equal(unrouted.status, 404);
      const foreign = await http(relay, 'POST', '/pair-code/resolve', {
        body: { code: '123456' },
        headers: { Origin: 'https://example.invalid' },
      });
      assert.equal(foreign.status, 403);
    });

    await t.test('repeated wrong pair codes reach the rate limit', async () => {
      let limited: Reply | null = null;
      for (let attempt = 0; attempt < 12 && limited === null; attempt++) {
        const reply = await http(relay, 'POST', '/pair-code/resolve', { body: { code: '000000' } });
        if (reply.status === 429) limited = reply;
        else assert.equal(reply.status, 404);
      }
      assert.ok(limited, 'repeated wrong codes reach the rate limit');
      const wait = (limited.json() as { status: string; retryAfter: number }).retryAfter;
      assert.equal((limited.json() as { status: string }).status, 'rate-limited');
      assert.ok(wait >= 59 && wait <= 60, `retryAfter ${wait}`);
      assert.equal(limited.headers['retry-after'], String(wait));
    });

    await t.test('repeated presence probes reach the rate limit', async () => {
      let throttled: Reply | null = null;
      for (let attempt = 0; attempt < 100 && throttled === null; attempt++) {
        const reply = await http(relay, 'POST', '/pair-code/presence', { body: { ids: [deviceId] } });
        if (reply.status === 429) throttled = reply;
        else assert.equal(reply.status, 200);
      }
      assert.ok(throttled, 'repeated presence probes reach the rate limit');
      assert.deepEqual(throttled.json(), { status: 'rate-limited' });
      assert.equal(throttled.headers['retry-after'], '60');
    });

    await t.test('the relay answers a cleartext ping while the desktop leg is up', async () => {
      observer = new RawPhone(relay, pairingToken);
      raws.push(observer);
      await until(
        () => desktop.opened.find((open) => open.clientId && open.clientId !== desktop.opened[0]!.clientId),
        'the second phone to be announced'
      );
      observer.send('{"ping":1}');
      await observer.text('{"pong":1}');
    });

    await t.test(
      'the desktop leg leaves: pong still answers, resync desktop-gone arrives, the session ends',
      async () => {
        desktop.close();
        await observer.text('{"resync":"desktop-gone"}');
        const end = await until(() => first.closes[0], 'the session to end');
        assert.deepEqual(end, { code: 1012, reason: 'desktop leg gone' });
        assert.deepEqual(phone.ends.at(-1), {
          code: 1012,
          reason: 'desktop leg gone',
          info: { ready: true, remote: false, quiet: false },
        });
        // The relay itself answers, with no desktop behind it.
        observer.texts.length = 0;
        observer.send('{"ping":1}');
        await observer.text('{"pong":1}');
        assert.equal(observer.closed, null);
      }
    );

    await t.test('the desktop leg returns: the kept socket is re-challenged and takes over', async () => {
      desktop = connectDesktop();
      await desktop.frame('relay-capabilities');
      await until(() => desktop.opened.length >= 2, 'both phones to be announced to the new leg');
      assert.ok(desktop.opened.some((open) => open.browserClientId === clientId));
      const reusedBefore = phone.stages.reused;
      writer = await phone.connector.open({ id: deviceId }, second.sink);
      assert.equal(phone.stages.reused, reusedBefore + 1);
      assert.equal(phone.readies.length, 2);
      writer.send(rpc(2, 'thread/read'));
      const answered = await until(
        () => second.frames.find((text) => JSON.parse(text).id === 2),
        'the answer on the new leg'
      );
      assert.deepEqual(JSON.parse(answered), { jsonrpc: '2.0', id: 2, result: { echo: 'thread/read' } });
      assert.deepEqual(second.closes, []);
    });

    await t.test('the offline window ends: 4002 reaches the phone, and a new phone is refused with it', async () => {
      const endsBefore = phone.ends.length;
      desktop.close();
      await until(() => second.closes[0], 'the second session to end');
      assert.equal(second.closes[0]!.code, 1012);
      const offline = await until(
        () => phone.ends.slice(endsBefore).find((end) => end.code === 4002),
        'the parked socket to be closed 4002',
        OFFLINE_WINDOW_LIMIT_MS
      );
      assert.equal(offline.reason, 'desktop offline');
      assert.equal(offline.info.remote, true);
      assert.equal(terminalOfClose(offline.code, offline.reason), undefined);
      const raw = await observer.end(OFFLINE_WINDOW_LIMIT_MS);
      assert.deepEqual(raw, { code: 4002, reason: 'desktop offline' });
      const late = new RawPhone(relay, pairingToken);
      raws.push(late);
      assert.deepEqual(await late.end(), { code: 4002, reason: 'desktop offline' });
    });

    await t.test('a credential the relay does not know is a lost pairing (4005)', async () => {
      const stale = new RawPhone(relay, randomBytes(32).toString('hex'));
      raws.push(stale);
      const closed = await stale.end();
      assert.equal(closed.code, 4005);
      assert.equal(closed.reason, 'pairing rescan required');
      assert.equal(terminalOfClose(closed.code, closed.reason), 'pairing-lost');

      const lost = phoneConnector(relay, identity, () => randomBytes(32).toString('hex'), sockets);
      await assert.rejects(lost.connector.open({ id: deviceId }, recordingSink().sink), /closed before ready \(4005/);
      assert.equal(lost.ends.at(-1)!.code, 4005);
      assert.equal(terminalOfClose(lost.ends.at(-1)!.code, lost.ends.at(-1)!.reason), 'pairing-lost');
      assert.equal(lost.ends.at(-1)!.info.ready, false);
    });

    await t.test('/app/latest.json answers 404 with no body when no release is known', async () => {
      const reply = await http(relay, 'GET', '/app/latest.json');
      assert.equal(reply.status, 404);
      assert.equal(reply.text, '');
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.equal(reply.headers['x-content-type-options'], 'nosniff');
      assert.equal((await http(relay, 'POST', '/app/latest.json')).status, 405);
    });
  });
}

test('the Rust relay serves the release the Android updater reads', { timeout: 60_000 }, async (t) => {
  const url = 'https://github.com/tribgames/mixdog/releases/download/mobile-v1.2.3/mixdog-1.2.3.apk';
  const relay = await startRelay('rust', { mobileRelease: { androidUrl: url } });
  t.after(() => relay.stop());
  const reply = await http(relay, 'GET', '/app/latest.json');
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(reply.json(), { version: '1.2.3', url });
  const head = await http(relay, 'HEAD', '/app/latest.json');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  // The same release sends an Android phone straight to the APK from /app.
  const app = await http(relay, 'GET', '/app', { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14)' } });
  assert.equal(app.status, 302);
  assert.equal(app.headers.location, url);
});
