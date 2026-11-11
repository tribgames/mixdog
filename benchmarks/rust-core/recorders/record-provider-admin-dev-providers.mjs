#!/usr/bin/env node
// provider-admin-dev-providers.test.mjs (1 test), recorded through the REAL DAEMON over its socket: the daemon entry (src/standalone/daemon.mjs) is started as a process over a data directory of
// the recording; the recorder is the desktop: it registers as a session client (POST /client/register), follows the session events stream (GET /events) and sends the admin requests a desktop
// sends (POST /call: session.create, then session.read / session.configure with the actions setDeveloperOption, getDeveloperSettings, getProviderSetup, getProviderAccounts). The dev-only OAuth
// providers appear and disappear per flag without a reload. The config file on disk (mixdog-config.json of the data directory) is read before and after each request that changes it.
//
// Ownership: the data directory belongs to one recording at a time. A recording holds a named pipe for its whole life; a second one waits, before it touches the directory, for that pipe's
// connection to close (the first recording's process has ended). The daemon runs in a Windows job of this recording (lib/process-job.mjs: kill on close, no breakaway): when it has exited
// the job is waited empty (JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO) before the recording ends, so nothing the daemon started outlives it and holds the directory's files.
//   node benchmarks/rust-core/recorders/record-provider-admin-dev-providers.mjs --tree <exact export of b6f10295a>
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as realTimeout, clearTimeout as realClear } from 'node:timers';
import { join } from 'node:path';
import { RecorderError, startRecording } from './lib/provider-case-recorder.mjs';
import { withJob } from './lib/process-job.mjs';

const DEADLINE_MS = 120_000;
const withDeadline = (promise, what) => new Promise((resolve, reject) => {
  const timer = realTimeout(() => reject(new RecorderError(`recorder: ${what} did not happen within ${DEADLINE_MS} ms`)), DEADLINE_MS);
  promise.then((value) => { realClear(timer); resolve(value); }, (error) => { realClear(timer); reject(error instanceof RecorderError ? error : new RecorderError(`recorder: ${what}: ${error?.message ?? error}`)); });
});

// The directory's owner pipe: listening on it is owning the directory; a recording that finds it taken waits for the owner's connection to close.
const OWNER_PIPE = '\\\\.\\pipe\\mixdog-recording-provider-admin-dev-providers';
for (;;) {
  const owner = net.createServer((socket) => socket.unref().on('error', () => {}));
  const taken = await new Promise((resolve) => owner.once('error', resolve).listen(OWNER_PIPE, () => resolve(null)));
  if (!taken) {
    owner.unref();
    break;
  }
  if (taken.code !== 'EADDRINUSE') throw new RecorderError(`recorder: the directory's owner pipe: ${taken.message}`);
  await withDeadline(new Promise((resolve) => net.connect(OWNER_PIPE).on('error', resolve).on('close', resolve).resume()), 'the previous recording of this directory ending');
}

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-admin-dev-providers',
  net: false,
  entry: 'src/standalone/daemon.mjs (the real daemon process: session front door on 127.0.0.1:47311, per-daemon token in daemon.json) with the desktop requests POST /client/register and POST /call { name: session.create | session.read | session.configure, args: { sessionId, action, args } } with the actions setDeveloperOption(id, enabled), getDeveloperSettings, getProviderSetup and getProviderAccounts(id); the config file mixdog-config.json of the data directory before and after each change. The daemon boots with MIXDOG_DAEMON_SKIP_MEMORY=1 and MIXDOG_RUNTIME_ROOT / MIXDOG_SESSION_PORT pointing into the recording. The desktop requests go through a loopback tap on 127.0.0.1:47312 that forwards every byte unchanged both ways.',
  exclusions: [
    'requests[].head: the request head exactly as its bytes arrived at the daemon\'s socket (request line, header lines in arrival order with their case, spacing and values, the closing blank line), read by the loopback tap; the one replacement in it is the value of X-Mixdog-Daemon-Token (the per-daemon random token from daemon.json), written as <daemon token>. requests[].body is the body as it arrived, the client token in it (random, returned by /client/register) written as <client token>',
    'responses: the session id (random) as <session id>; the revision / baseRevision / updatedAt / createdAt / startedAt numbers (the daemon clock) as <daemon clock>; inside result.full: clientHostPid and agentScope.clientHostPid (the daemon pid) as <daemon pid>, setupChanged.at (the daemon wall clock) as <daemon clock>; every other leaf, setupChanged.action and .seq and the presence of agentScope and setupChanged included, is recorded as it was',
    'the order of the daemon\'s asynchronous session-view updates is fixed by events of its session events stream (GET /events, the stream a desktop follows; not recorded): after session.create the recording waits for the update that attaches the host scope (agentScope); after each setDeveloperOption that changes the config file, it waits for the file to hold the flag and for the daemon\'s setupChanged announcement of that change before the next request',
    'the daemon process, its pid and the session events stream are not recorded: only the HTTP exchanges with the front door and the config file text',
  ],
  compare: 'per step: send the recorded requests to the Rust daemon front door in order and compare each response whole (setDeveloperOption result, getDeveloperSettings, getProviderSetup oauth rows, listProviders rows, getProviderAccounts result or error) and the config file text the daemon wrote after each setDeveloperOption.',
  replay: "WIRE: the desktop requests as sent over a socket to the Rust daemon (the same /client/register and /call exchanges). No public Rust function replaces the daemon entry for these admin requests; the pure functions named in earlier revisions (service/admin_models provider_available, ai_account provider_setup and list_provider_accounts) cover availability, setup rows and the account error only, not the status rows nor the config writes.",
});
const DEV = ['mimo-oauth', 'cursor-oauth', 'devin-oauth', 'antigravity-oauth'];
const KNOWN = [...DEV, 'openai-oauth', 'muse-code-oauth', 'command-code-oauth', 'openai', 'mixdog-local'];
const OPTION_OF = { 'mimo-oauth': 'mimoOAuth', 'cursor-oauth': 'cursorOAuth', 'devin-oauth': 'devinOAuth', 'antigravity-oauth': 'antigravityOAuth' };
const SRC = 'src/standalone/provider-admin-dev-providers.test.mjs';
const PORT = 47311;
const TAP_PORT = 47312;
const DAEMON_LIFE_MS = 900_000;
const runtimeRoot = join(rec.dataDir, 'runtime');
const configPath = join(rec.dataDir, 'mixdog-config.json');
const discoveryPath = join(runtimeRoot, 'daemon.json');

await withJob('provider-admin-dev-providers daemon', async (job) => {
  // The daemon: a real process of the tree in this recording's job; ready when it has published daemon.json (written once its session front door listens, a file event), ended by POST /shutdown
  // and its exit, after which the job is waited empty.
  mkdirSync(runtimeRoot, { recursive: true });
  const daemonRun = job.run('the daemon', process.execPath, [join(rec.tree, 'src/standalone/daemon.mjs')], {
    cwd: process.cwd(),
    env: { ...process.env, MIXDOG_RUNTIME_ROOT: runtimeRoot, MIXDOG_SESSION_PORT: String(PORT), MIXDOG_DAEMON_SKIP_MEMORY: '1' },
    ms: DAEMON_LIFE_MS,
  });
  const published = () => {
    try {
      return JSON.parse(readFileSync(discoveryPath, 'utf8')).endpoints?.session ?? null;
    } catch {
      return null;
    }
  };
  const discovery = await withDeadline(Promise.race([
    new Promise((resolve) => {
      if (published()) return resolve(published());
      const watcher = watch(runtimeRoot, () => { const found = published(); if (found) { watcher.close(); resolve(found); } });
    }),
    daemonRun.then((ended) => { throw new RecorderError(`recorder: the daemon exited before it published daemon.json (code ${ended.code}): ${ended.stderr.slice(-600)}`); }),
  ]), 'the daemon publishing daemon.json');

  // The request head as it arrives at the daemon's socket: the desktop's requests go through a loopback tap that forwards every byte both ways unchanged and keeps, from the bytes it forwards to
  // the daemon, each request head as bytes (up to and including the blank line), skipping the body by its Content-Length.
  const arrivedHeads = [];
  const tap = net.createServer((client) => {
    const daemonSocket = net.connect(PORT, '127.0.0.1');
    client.pipe(daemonSocket);
    daemonSocket.pipe(client);
    client.on('error', () => daemonSocket.destroy());
    daemonSocket.on('error', () => client.destroy());
    let pending = Buffer.alloc(0);
    let bodyLeft = 0;
    client.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (bodyLeft > 0) {
          const taken = Math.min(bodyLeft, pending.length);
          bodyLeft -= taken;
          pending = pending.subarray(taken);
          if (bodyLeft > 0) return;
        }
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = Buffer.from(pending.subarray(0, end + 4));
        arrivedHeads.push(head);
        const length = /\r\ncontent-length:[ \t]*(\d+)/i.exec(head.toString('latin1'));
        bodyLeft = length ? Number(length[1]) : 0;
        pending = pending.subarray(end + 4);
      }
    });
  });
  await withDeadline(new Promise((resolve, reject) => tap.once('error', reject).listen(TAP_PORT, '127.0.0.1', resolve)), `the tap listening on 127.0.0.1:${TAP_PORT}`);
  tap.unref();

  // One HTTP exchange through the tap. A failure of the exchange itself (the socket, the parse of the daemon's JSON) is the recorder's, never an answer.
  const exchange = (method, path, headers, payload) => withDeadline(new Promise((resolve, reject) => {
    const text = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request({ hostname: '127.0.0.1', port: TAP_PORT, path, method, headers: { ...headers, ...(text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      // The exchanges are sequential: the head the tap read last is this request's.
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), head: arrivedHeads.at(-1), requestBody: text }));
    });
    req.on('error', reject);
    if (text) req.write(text);
    req.end();
  }), `${method} ${path}`);
  const json = (text, what) => {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new RecorderError(`recorder: ${what} is not JSON: ${error.message}: ${text.slice(0, 200)}`);
    }
  };
  const health = json((await exchange('GET', '/health', {})).text, 'the /health answer');
  const registered = json((await exchange('POST', '/client/register', { 'X-Mixdog-Daemon-Token': discovery.token }, { leadPid: 0, cwd: rec.dataDir, lifecycle: false, clientKind: 'desktop', registrationId: 'recording-desktop', protocol: health.protocol, revision: health.revision })).text, 'the /client/register answer');
  const clientToken = registered.token;

  // The session events stream (as a desktop follows it), straight to the daemon: every session-state update is kept for the waits below; each update wakes them.
  const updates = [];
  const waiters = new Set();
  const untilUpdate = (predicate, what) => withDeadline(new Promise((resolve) => {
    const check = () => { if (predicate()) { waiters.delete(check); resolve(); } };
    waiters.add(check);
    check();
  }), what);
  await withDeadline(new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: PORT, path: `/events?token=${encodeURIComponent(clientToken)}`, headers: { 'X-Mixdog-Daemon-Token': discovery.token } }, (res) => {
      if (res.statusCode !== 200) return reject(new RecorderError(`recorder: GET /events answered ${res.statusCode}`));
      res.setEncoding('utf8');
      let buffered = '';
      res.on('data', (chunk) => {
        buffered += chunk;
        let at;
        while ((at = buffered.indexOf('\n\n')) >= 0) {
          const message = buffered.slice(0, at);
          buffered = buffered.slice(at + 2);
          for (const line of message.split('\n')) if (line.startsWith('data: ')) updates.push(json(line.slice(6), 'a session event'));
          for (const w of [...waiters]) w();
        }
      });
      resolve();
    });
    req.on('error', reject);
    req.unref?.();
  }), 'the session events stream opening');
  const fields = (update) => update.patch?.set ?? update.full ?? {};
  const announcements = () => updates.filter((u) => fields(u).setupChanged).length;

  let sessionId = null;
  const maskText = (text) => {
    let out = text.replaceAll(clientToken, '<client token>').replaceAll(discovery.token, '<daemon token>');
    if (sessionId) out = out.replaceAll(sessionId, '<session id>');
    return out;
  };
  const maskRevisions = (value) => {
    if (Array.isArray(value)) return value.map(maskRevisions);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(revision|baseRevision|updatedAt|createdAt|startedAt)$/.test(k) && typeof v === 'number' ? '<daemon clock>' : maskRevisions(v)]));
    return value;
  };
  let callNo = 0;
  const call = async (name, args) => {
    const sent = await exchange('POST', '/call', { 'X-Mixdog-Daemon-Token': discovery.token }, { token: clientToken, name, args, callId: `recording-${++callNo}` });
    const parsed = json(sent.text, `the /call ${name} answer`);
    if (!sessionId && parsed.result?.sessionId) sessionId = parsed.result.sessionId;
    const masked = maskRevisions(json(maskText(sent.text), `the /call ${name} answer`));
    // Inside `result.full` (the daemon's projection of the session view) only the leaves that are a pid or the daemon's clock are markers (declared in the manifest).
    const full = masked.result?.full;
    if (full && typeof full === 'object') {
      if (typeof full.clientHostPid === 'number') full.clientHostPid = '<daemon pid>';
      if (full.agentScope && typeof full.agentScope.clientHostPid === 'number') full.agentScope.clientHostPid = '<daemon pid>';
      if (full.setupChanged && typeof full.setupChanged.at === 'number') full.setupChanged.at = '<daemon clock>';
    }
    const reply = JSON.stringify(masked);
    rec.net.records.push({ origin: `http://127.0.0.1:${TAP_PORT}`, head: Buffer.from(sent.head.toString('latin1').replaceAll(discovery.token, '<daemon token>'), 'latin1'), body: maskText(sent.requestBody), reply: { status: sent.status, body: reply } });
    return { status: sent.status, body: JSON.parse(reply) };
  };
  const action = (route, name, args) => call(route, { sessionId, action: name, args });
  const configText = () => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : null);
  // The daemon saves its config with a debounce: the recording waits for the file itself to hold the flag (a file-system event with a deadline).
  const untilConfigHolds = (option, value) => withDeadline(new Promise((resolve) => {
    const holds = () => {
      try {
        return (JSON.parse(readFileSync(configPath, 'utf8')).agent?.developer ?? {})[option] === value;
      } catch {
        return false;
      }
    };
    if (holds()) return resolve();
    const watcher = watch(rec.dataDir, () => { if (holds()) { watcher.close(); resolve(); } });
  }), `the config file to hold ${option}=${value}`);
  // One flag: the request, the file holding it, and - when the file changed - the daemon's announcement of that change on the events stream.
  const setOption = async (option, value) => {
    const before = configText();
    const announced = announcements();
    const response = await action('session.configure', 'setDeveloperOption', [option, value]);
    await untilConfigHolds(option, value);
    if (configText() !== before) await untilUpdate(() => announcements() > announced, `the daemon's setupChanged announcement of ${option}=${value}`);
    return response;
  };

  const step = async (developer) => {
    const out = { developer, requests: [] };
    if (developer) {
      out.configBefore = configText();
      for (const option of Object.values(OPTION_OF)) out.requests.push({ route: 'session.configure', action: 'setDeveloperOption', args: [option, developer[option] === true], response: await setOption(option, developer[option] === true) });
      out.configAfter = configText();
    }
    out.settings = await action('session.read', 'getDeveloperSettings', []);
    // `force: true` asks for the authoritative setup: an unforced request (`recheckKeychain` included) is answered from the warm-up cache, a quick
    // snapshot while the setup the config change invalidated is being rebuilt (session-runtime/provider-auth/setup.mjs:56), which depends on
    // timing; the forced request rebuilds and always returns the full answer.
    out.setup = await action('session.read', 'getProviderSetup', [{ force: true }]);
    out.accounts = {};
    for (const id of KNOWN) out.accounts[id] = await action('session.read', 'getProviderAccounts', [id]);
    return out;
  };
  const steps = [{ cursorOAuth: true }, { mimoOAuth: true }, { mimoOAuth: true, cursorOAuth: true, devinOAuth: true, antigravityOAuth: true }, { mimoOAuth: false, cursorOAuth: false, antigravityOAuth: true }, { mimoOAuth: false, cursorOAuth: false, antigravityOAuth: false }];
  await rec.run('dev-oauth-providers-follow-developer-flags', `${SRC}:33`, { developerSteps: [null, ...steps], known: KNOWN }, async () => {
    const created = await call('session.create', { cwd: rec.dataDir });
    // The daemon attaches the host's scope to the new session asynchronously: its update on the events stream comes before the next request.
    await untilUpdate(() => updates.some((u) => u.sessionId === sessionId && fields(u).agentScope), 'the session update attaching the host scope');
    const out = [await step(null)];
    for (const developer of steps) out.push(await step(developer));
    return { created, steps: out };
  });
  await exchange('POST', '/shutdown', { 'X-Mixdog-Daemon-Token': discovery.token }, {});
  const ended = await withDeadline(daemonRun, 'the daemon exiting after POST /shutdown and its job emptying');
  if (ended.timedOut) throw new RecorderError(`recorder: the daemon outlived its ${DAEMON_LIFE_MS} ms`);
  tap.close();
});
await rec.finish();
