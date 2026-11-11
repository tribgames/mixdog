#!/usr/bin/env node
// provider-admin-dev-providers.test.mjs (1 test), recorded through the REAL DAEMON over its socket: the daemon entry (src/standalone/daemon.mjs) is started as a process over a data directory of
// the recording; the recorder is the desktop: it registers as a session client (POST /client/register) and sends the admin requests a desktop sends (POST /call: session.create, then session.read / session.configure with the actions setDeveloperOption,
// getDeveloperSettings, getProviderSetup, getProviderAccounts). The dev-only OAuth providers appear and disappear per flag without a reload. The config file on disk
// (mixdog-config.json of the data directory) is read before and after each request that changes it.
//   node benchmarks/rust-core/recorders/record-provider-admin-dev-providers.mjs --tree <exact export of b6f10295a>
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, watch } from 'node:fs';
import http from 'node:http';
import { setTimeout as realTimeout, clearTimeout as realClear } from 'node:timers';
import { join } from 'node:path';
import { startRecording } from './lib/provider-case-recorder.mjs';

// Processes the daemon leaves behind (its embedded database tools) are stopped by their command line, which names the data directory of the recording (the pattern is written in two pieces so that the stopping process does not match itself): before the recording starts (a failed earlier
// run) and after the daemon has exited.
const DATA_DIR = 'D:/mixdog-build/tmp/w22/provider-admin-dev-providers';
const stopLeftovers = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*mixdog-build/tmp/w22/provider-admin-dev-' + 'providers/*') -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0`], { timeout: 60_000 });
stopLeftovers();
const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-admin-dev-providers',
  net: false,
  entry: 'src/standalone/daemon.mjs (the real daemon process: session front door on a loopback port, per-daemon token in daemon.json) with the desktop requests POST /client/register and POST /call { name: session.create | session.read | session.configure, args: { sessionId, action, args } } with the actions setDeveloperOption(id, enabled), getDeveloperSettings, getProviderSetup and getProviderAccounts(id); the config file mixdog-config.json of the data directory before and after each change. The daemon boots with MIXDOG_DAEMON_SKIP_MEMORY=1 and MIXDOG_RUNTIME_ROOT / MIXDOG_SESSION_PORT pointing into the recording.',
  exclusions: [
    'result.full of every /call response (the daemon projection of the session view: items, client host pid, revisions) is written as <session view projection>; the session id and the revision / updatedAt / createdAt / startedAt numbers of the daemon (its clock) in a response are written as <session id> and <daemon clock>; requests[].headers: the VALUES of x-mixdog-daemon-token (the per-daemon random token read from daemon.json) and the client token in the body (random, returned by /client/register) are written as <daemon token> and <client token>; host carries the fixed session port of the recording as <port>; every other header and the body are recorded as sent',
    'the daemon process, its pid and its listening ports are not recorded: only the HTTP exchanges with the front door and the config file text',
  ],
  compare: 'per step: send the recorded requests to the Rust daemon front door in order and compare each response whole (setDeveloperOption result, getDeveloperSettings, getProviderSetup oauth rows, listProviders rows, getProviderAccounts result or error) and the config file text the daemon wrote after each setDeveloperOption.',
  replay: "WIRE: the desktop requests as sent over a socket to the Rust daemon (the same /client/register and /call exchanges). No public Rust function replaces the daemon entry for these admin requests; the pure functions named in earlier revisions (service/admin_models provider_available, ai_account provider_setup and list_provider_accounts) cover availability, setup rows and the account error only, not the status rows nor the config writes.",
});
const DEADLINE_MS = 120_000;
const DEV = ['mimo-oauth', 'cursor-oauth', 'devin-oauth', 'antigravity-oauth'];
const KNOWN = [...DEV, 'openai-oauth', 'muse-code-oauth', 'command-code-oauth', 'openai', 'mixdog-local'];
const OPTION_OF = { 'mimo-oauth': 'mimoOAuth', 'cursor-oauth': 'cursorOAuth', 'devin-oauth': 'devinOAuth', 'antigravity-oauth': 'antigravityOAuth' };
const SRC = 'src/standalone/provider-admin-dev-providers.test.mjs';
const PORT = 47311;
const runtimeRoot = join(rec.dataDir, 'runtime');
const configPath = join(rec.dataDir, 'mixdog-config.json');
const withDeadline = (promise, what) => new Promise((resolve, reject) => {
  const timer = realTimeout(() => reject(new Error(`recorder: ${what} did not happen within ${DEADLINE_MS} ms`)), DEADLINE_MS);
  promise.then((value) => { realClear(timer); resolve(value); }, (error) => { realClear(timer); reject(error); });
});

// The daemon: a real process of the tree; ready when it prints that the session front door listens (an event of its output), ended by POST /shutdown and its exit event.
const daemon = spawn(process.execPath, [join(rec.tree, 'src/standalone/daemon.mjs')], {
  env: { ...process.env, MIXDOG_RUNTIME_ROOT: runtimeRoot, MIXDOG_SESSION_PORT: String(PORT), MIXDOG_DAEMON_SKIP_MEMORY: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const exited = new Promise((resolve) => daemon.once('exit', resolve));
let daemonOutput = '';
const ready = new Promise((resolve, reject) => {
  const onOutput = (chunk) => { daemonOutput += chunk; if (/session front door on 127\.0\.0\.1:\d+/.test(daemonOutput)) resolve(); };
  daemon.stdout.on('data', onOutput);
  daemon.stderr.on('data', onOutput);
  daemon.once('exit', (code) => reject(new Error(`recorder: the daemon exited before it listened (code ${code}): ${daemonOutput.slice(-400)}`)));
});
await withDeadline(ready, 'the daemon front door listening').catch((error) => { throw new Error(`${error.message}; daemon output: ${daemonOutput.slice(-600)}`); });
const discovery = JSON.parse(readFileSync(join(runtimeRoot, 'daemon.json'), 'utf8')).endpoints.session;

const exchange = (method, path, headers, payload) => withDeadline(new Promise((resolve, reject) => {
  const text = payload === undefined ? null : JSON.stringify(payload);
  const req = http.request({ hostname: '127.0.0.1', port: PORT, path, method, headers: { ...headers, ...(text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {}) } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), requestHeaders: req.getHeaders(), requestBody: text }));
  });
  req.on('error', reject);
  if (text) req.write(text);
  req.end();
}), `${method} ${path}`);
const health = JSON.parse((await exchange('GET', '/health', {})).text);
const registered = JSON.parse((await exchange('POST', '/client/register', { 'X-Mixdog-Daemon-Token': discovery.token }, { leadPid: 0, cwd: rec.dataDir, lifecycle: false, clientKind: 'desktop', registrationId: 'recording-desktop', protocol: health.protocol, revision: health.revision })).text);
const clientToken = registered.token;

// One desktop request: recorded as the HTTP exchange. The tokens, the session id and the session revision numbers (the clock of the daemon) are random or wall-clock values: they are written as markers at
// exactly those places (declared in the manifest); everything else in the request and the response is recorded as it was.
let sessionId = null;
const mask = (text) => {
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
  const parsed = JSON.parse(sent.text);
  if (!sessionId && parsed.result?.sessionId) sessionId = parsed.result.sessionId;
  const masked = maskRevisions(JSON.parse(mask(sent.text)));
  // `result.full` is the daemon's projection of the session view (items, host pid, revisions): not part of the admin answer, written as a marker at that one path.
  if (masked.result && 'full' in masked.result) masked.result.full = '<session view projection>';
  const reply = JSON.stringify(masked);
  rec.net.records.push({ method: 'POST', origin: 'http://127.0.0.1:<port>', path: '/call', headers: Object.entries(sent.requestHeaders).map(([n, v]) => [n, n === 'x-mixdog-daemon-token' ? '<daemon token>' : n === 'host' ? '127.0.0.1:<port>' : v]), body: mask(sent.requestBody), reply: { status: sent.status, body: reply } });
  return { status: sent.status, body: JSON.parse(reply) };
};
await call('session.create', { cwd: rec.dataDir });
const action = (route, name, args) => call(route, { sessionId, action: name, args });
// The daemon saves its config with a debounce: the next read of the stored developer flags sees the file as written, so the recording waits for the file itself to hold the flags (a file-system event with a deadline).
const untilConfigHolds = (expected) => withDeadline(new Promise((resolve) => {
  const holds = () => {
    if (!existsSync(configPath)) return false;
    try {
      const developer = JSON.parse(readFileSync(configPath, 'utf8')).agent?.developer ?? {};
      return Object.entries(expected).every(([option, value]) => developer[option] === value);
    } catch {
      return false;
    }
  };
  if (holds()) return resolve();
  const watcher = watch(rec.dataDir, () => { if (holds()) { watcher.close(); resolve(); } });
}), `the config file to hold ${JSON.stringify(expected)}`);
const configText = () => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : null);

const step = async (developer) => {
  const out = { developer, requests: [] };
  if (developer) {
    out.configBefore = configText();
    for (const option of Object.values(OPTION_OF)) out.requests.push({ route: 'session.configure', action: 'setDeveloperOption', args: [option, developer[option] === true], response: await action('session.configure', 'setDeveloperOption', [option, developer[option] === true]) });
    await untilConfigHolds(Object.fromEntries(Object.values(OPTION_OF).map((option) => [option, developer[option] === true])));
    out.configAfter = configText();
  }
  out.settings = await action('session.read', 'getDeveloperSettings', []);
  out.setup = await action('session.read', 'getProviderSetup', [{}]);
  out.accounts = {};
  for (const id of KNOWN) out.accounts[id] = await action('session.read', 'getProviderAccounts', [id]);
  return out;
};
await rec.run('dev-oauth-providers-follow-developer-flags', `${SRC}:33`, { developerSteps: [null, { cursorOAuth: true }, { mimoOAuth: true }, { mimoOAuth: true, cursorOAuth: true, devinOAuth: true, antigravityOAuth: true }, { mimoOAuth: false, cursorOAuth: false, antigravityOAuth: true }, { mimoOAuth: false, cursorOAuth: false, antigravityOAuth: false }], known: KNOWN }, async () => {
  const steps = [await step(null)];
  for (const developer of [{ cursorOAuth: true }, { mimoOAuth: true }, { mimoOAuth: true, cursorOAuth: true, devinOAuth: true, antigravityOAuth: true }, { mimoOAuth: false, cursorOAuth: false, antigravityOAuth: true }, { mimoOAuth: false, cursorOAuth: false, antigravityOAuth: false }]) steps.push(await step(developer));
  return { steps };
});
await exchange('POST', '/shutdown', { 'X-Mixdog-Daemon-Token': discovery.token }, {}).catch(() => {});
await withDeadline(exited, 'the daemon exiting after POST /shutdown');
stopLeftovers();
await rec.finish();
