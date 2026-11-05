#!/usr/bin/env node
// Desktop-service golden twins for the domains that sit behind the desktop
// main process: terminal, LSP, settings, GitHub (through the real
// `createDesktopOperations` dispatcher, which needs no Electron once the
// extensionless TS imports resolve), notifications, file transfer and the
// remote/relay device leg (domain modules loaded directly; the relay's remote
// end is a local `ws` server stand-in). No module here imports `electron`.
// Everything runs in a temp userData / MIXDOG_DATA_DIR; fake data only.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-desktop-services.mjs --tree <dir>
import { chmodSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const { WebSocketServer } = await import(pathToFileURL(join(resolveTree(args), 'node_modules/ws/wrapper.mjs')).href);
const tree = resolveTree(args);
const work = mkdtempSync(join(tmpdir(), 'mixdog-ds-svc-'));
const userData = join(work, 'userData');
const dataDir = join(work, 'data');
const project = join(work, 'project');
for (const d of [userData, dataDir, project]) mkdirSync(d, { recursive: true });
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_HOME = join(work, 'home');
const M = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);

const fwd = (p) => p.replace(/\\/g, '/');
const scrub = (value) => {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  for (const root of [work, tree]) {
    for (const v of [typeof value === 'string' ? root : null, fwd(root), JSON.stringify(root).slice(1, -1)].filter(Boolean)) text = text.replaceAll(v, v === tree || fwd(tree) === v ? '<TREE>' : '<WORK>');
  }
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<UUID>').replace(/\b[0-9a-f]{32,}\b/g, '<HEX>');
  // A download `version` is sha256(dev:ino:size:mtimeNs) of the host's file identity: host-specific, format fixed (43 base64url chars).
  text = text.replace(/("version":\s*")[A-Za-z0-9_-]{43}(")/g, '$1<VERSION>$2');
  text = text.replace(/\b1[67]\d{11}\b/g, typeof value === 'string' ? '<MS>' : '0');
  return typeof value === 'string' ? text : JSON.parse(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const corpora = {};
const rec = async (domain, op, input, fn) => {
  let out;
  if (process.env.DS_TRACE) console.error('>>', domain, op);
  try { out = { result: await Promise.race([fn(), sleep(20000).then(() => { throw new Error('recorder timeout after 20s'); })]) }; } catch (e) { out = { error: { name: e?.name ?? null, message: String(e?.message ?? e) } }; }
  (corpora[domain] ??= []).push(scrub({ op, args: input, ...out }));
};

// ---- dispatcher: settings, GitHub gate, terminal, LSP --------------------------
const events = [];
const listeners = new Set();
const { createDesktopOperations } = await M('desktop-operations');
const ops = createDesktopOperations({ userDataPath: userData, packaged: false, resourcesPath: undefined, appPath: join(tree, 'apps', 'desktop'), emit: (e) => { events.push(e); for (const l of [...listeners]) l(e); } });
// Resolves when the terminal's output events (accumulated from now) satisfy `test`; no timers: the recorder's rec() deadline bounds it.
const outputUntil = (test) => new Promise((resolve) => {
  let seen = '';
  const l = (e) => { if (e?.name === 'terminal-data') { seen += e.value.data; if (test(seen)) { listeners.delete(l); resolve(seen); } } };
  listeners.add(l);
});
const call = (domain, name, ...a) => rec(domain, name, a, () => ops.invoke(name, a));

await call('settings', 'readSettings');
await call('settings', 'readZoom');
await call('settings', 'updateZoom', 1.25);
await call('settings', 'updateZoom', 'bad');
await call('settings', 'readZoom');
await call('settings', 'updateNotificationVolume', 0.5);
await call('settings', 'updateNotificationVolume', 7);
await call('settings', 'updateSessionRetention', 'trace', 14);
await call('settings', 'updateSessionRetention', 'nonsense', 1);
await call('settings', 'readActivityRailPins');
await call('settings', 'updateActivityRailPins', ['files', 'git'], true);
await call('settings', 'readActivityRailPins');
await call('settings', 'updateSetting', 'nonexistentFlag', true);
await call('settings', 'readSettings');
await call('settings', 'unknownOperation');
corpora.settings.push({ op: '<emitted events>', events: scrub(events.splice(0)) });
for (const name of readdirSync(dataDir).filter((n) => /^config.*\.json$/.test(n))) writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', `store-after-`), scrub(JSON.parse(readFileSync(join(dataDir, name), 'utf8'))));

// GitHub: through the feature gate, then with an injected `run` for the command builder.
// Gate off: the dispatcher's real gh path would reach GitHub, which a recorder must never do.
process.env.MIXDOG_FEATURE_GIT = '0';
await call('github', 'githubRequest', project, { action: 'pr.list', repo: 'owner/name', state: 'open' });
{
  const gh = await M('github-service');
  const client = await importFrom(tree, 'src/runtime/github/client.mjs');
  const issued = [];
  const run = async (command, opts) => {
    issued.push({ command: { args: command.args, hostname: command.hostname, json: command.json, mutation: command.mutation, list: command.list ?? false, input: command.input ?? null }, cwd: opts.cwd });
    if (command.args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'owner/name' });
    if (command.args.includes('--paginate') || command.list) return JSON.stringify([{ number: 1, title: 'fixture', state: 'open' }]);
    return JSON.stringify({ number: 1, title: 'fixture' });
  };
  process.env.MIXDOG_FEATURE_GIT = '1';
  const service = gh.createGithubService(async () => ({ readConfig: () => ({}) }), (cwd, input) => client.executeGithubRequest(input, cwd, { run }));
  const cases = [
    { action: 'pr.list', repo: 'owner/name', state: 'open', limit: 5 },
    { action: 'pr.view', repo: 'owner/name', number: 1 },
    { action: 'issue.list', repo: 'owner/name' },
    { action: 'issue.comment', repo: 'owner/name', number: 3, body: 'fixture comment' },
    { action: 'pr.merge', repo: 'owner/name', number: 3, sha: 'a'.repeat(40) },
    { action: 'repo.list', owner: 'owner' },
    { action: 'pr.list' },
    { action: 'bogus.action' },
    { action: 'repo.clone', repo: 'owner/name', destination: join(work, 'clone-dest') },
  ];
  for (const c of cases) {
    issued.length = 0;
    await rec('github', 'createGithubService(gate=on)', [c], async () => ({ response: await service(project, c), spawned: JSON.parse(JSON.stringify(issued)) }));
  }
  process.env.MIXDOG_FEATURE_GIT = '0';
  const gateOff = gh.createGithubService(async () => ({ readConfig: () => ({}) }), () => { throw new Error('unreachable'); });
  await rec('github', 'createGithubService(gate=off)', [{ action: 'pr.list', repo: 'owner/name' }], () => gateOff(project, { action: 'pr.list', repo: 'owner/name' }));
}

// Terminal (real node-pty), deterministic through markers.
// Which shells exist (and where) is the host's; the recorded facts are the entry shape and the default count.
await rec('terminal', 'termProfiles', [], async () => {
  const profiles = await ops.invoke('termProfiles', []);
  return { entryKeys: [...new Set(profiles.flatMap((p) => Object.keys(p)))].sort(), nonEmpty: profiles.length > 0, defaultCount: profiles.filter((p) => p.default).length, pathsAbsolute: profiles.every((p) => typeof p.path === 'string' && p.path.length > 0) };
});
{
  let id = null;
  // The shell is ready when it has printed its prompt; input sent before that is lost to the pty (root cause of the
  // old containsMarker:false). The listener is armed before the spawn so the first prompt cannot be missed.
  const shellReady = outputUntil((s) => (process.platform === 'win32' ? /PS [^\r\n]*>/.test(s) : /[$#] $/.test(s)));
  await rec('terminal', 'termEnsure', [null, '<project>', null], async () => {
    const r = await ops.invoke('termEnsure', [null, project, { path: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', args: process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [] }]);
    id = r.id;
    return { id: '<id>', replayType: typeof r.replay, sizeOwner: r.sizeOwner ?? null };
  });
  if (id) {
    await call('terminal', 'termActivity');
    await Promise.race([shellReady, sleep(20000).then(() => { throw new Error('terminal: shell never printed a prompt'); })]);
    // The marker shows twice once the command ran: the input echo, then the command's own output.
    const markerOutput = outputUntil((s) => s.split('MIXDOG_FIXTURE_MARKER').length > 2);
    await rec('terminal', 'termWrite', ['<id>', 'echo MIXDOG_FIXTURE_MARKER\\r'], () => ops.invoke('termWrite', [id, process.platform === 'win32' ? 'echo MIXDOG_FIXTURE_MARKER\r' : 'echo MIXDOG_FIXTURE_MARKER\n']));
    await rec('terminal', 'termSnapshot', ['<id>'], async () => {
      await markerOutput; // the pty output event carrying the marker; the buffer is written before the event fires
      const s = await ops.invoke('termSnapshot', [id]);
      return { keys: Object.keys(s ?? {}).sort(), containsMarker: JSON.stringify(s).includes('MIXDOG_FIXTURE_MARKER'), cursorType: typeof s?.cursor };
    });
    await rec('terminal', 'termResize', ['<id>', 100, 30, 'client-a'], () => ops.invoke('termResize', [id, 100, 30, 'client-a']));
    await rec('terminal', 'termFocus', ['<id>', 'client-a', true], () => ops.invoke('termFocus', [id, 'client-a', true]));
    await rec('terminal', 'termPause', ['<id>'], () => ops.invoke('termPause', [id]));
    await rec('terminal', 'termResume', ['<id>'], () => ops.invoke('termResume', [id]));
    await rec('terminal', 'termAttach', ['<id>'], async () => { const a = await ops.invoke('termAttach', [id]); return { id: a?.id === id ? '<id>' : a?.id, hasReplay: typeof a?.replay === 'string' }; });
    await rec('terminal', 'termSessionTabs', ['session-x'], () => ops.invoke('termSessionTabs', ['session-x']));
    await rec('terminal', 'termDispose', ['<id>'], () => ops.invoke('termDispose', [id]));
    await rec('terminal', 'termAttach(after dispose)', ['<id>'], () => ops.invoke('termAttach', [id]));
  }
  await call('terminal', 'termWrite', 'no-such-terminal', 'x');
  const kinds = [...new Set(events.map((e) => e.channel ?? e.type ?? e.kind ?? 'unknown'))].sort();
  // Output chunking (hence the event count) depends on the shell and host; only "some events, of these kinds" is a fact.
  corpora.terminal.push({ op: '<emitted event kinds>', kinds, emitted: events.length > 0 });
  events.length = 0;
}

// LSP: unsupported language and a language whose server is not installed. Servers are looked up on PATH, so
// PATH is pinned to an empty directory: "rust-analyzer absent" is then the same on every host (a rustup shim
// or a real install would otherwise change the outcome and its timing).
const hostPath = process.env.PATH;
const emptyPath = join(work, 'empty-path');
mkdirSync(emptyPath);
process.env.PATH = emptyPath;
await call('lsp', 'lspDocument', project, project, { relPath: 'a.xyz', languageId: 'plaintext', text: 'x', version: 1 });
await call('lsp', 'lspDocument', project, project, { relPath: 'a.rs', languageId: 'rust', text: 'fn main(){}', version: 1 });
await call('lsp', 'lspRequest', project, project, 'a.xyz', 'plaintext', 'textDocument/hover', { position: { line: 0, character: 0 } });
await call('lsp', 'lspDisposeUnder', project);
// Happy path: a scripted stub registered on PATH as `rust-analyzer` (the product resolves it like any server).
// A second project root, because the missing result above is cached per root for 30 s.
{
  const stubBin = join(work, 'stub-bin');
  const project2 = join(work, 'project-lsp');
  mkdirSync(stubBin); mkdirSync(project2);
  const stubScript = fileURLToPath(new URL('./lib/lsp-stub.mjs', import.meta.url));
  if (process.platform === 'win32') writeFileSync(join(stubBin, 'rust-analyzer.cmd'), `@"${process.execPath}" "${stubScript}" %*\r\n`);
  else { writeFileSync(join(stubBin, 'rust-analyzer'), `#!/bin/sh\nexec "${process.execPath}" "${stubScript}" "$@"\n`); chmodSync(join(stubBin, 'rust-analyzer'), 0o755); }
  process.env.PATH = stubBin;
  // Resolves on the diagnostics event; rejects as soon as the product reports the server failed, with its own message.
  const diagnostics = new Promise((resolve, reject) => {
    const l = (e) => {
      if (e?.name === 'lsp-diagnostics') { listeners.delete(l); resolve(e); }
      else if (e?.name === 'lsp-status' && ['error', 'stopped', 'missing'].includes(e.value?.status)) { listeners.delete(l); reject(new Error(`lsp stub ${e.value.status}: ${e.value.message ?? e.value.detail ?? JSON.stringify(e.value)}`)); }
    };
    listeners.add(l);
  });
  diagnostics.catch(() => undefined);
  await call('lsp', 'lspDocument', project2, project2, { relPath: 'a.rs', languageId: 'rust', text: 'fn main(){}', version: 1 });
  await Promise.race([diagnostics, sleep(60000).then(() => { throw new Error(`lsp: no diagnostics from stub; statuses seen: ${JSON.stringify(events.filter((e) => e?.name === 'lsp-status').map((e) => e.value))}`); })]);
  await call('lsp', 'lspRequest', project2, project2, 'a.rs', 'rust', 'textDocument/hover', { position: { line: 0, character: 3 } });
  await call('lsp', 'lspRequest', project2, project2, 'a.rs', 'rust', 'textDocument/definition', { position: { line: 0, character: 3 } });
  await call('lsp', 'lspRequest', project2, project2, 'a.rs', 'rust', 'textDocument/completion', { position: { line: 0, character: 3 } });
  await call('lsp', 'lspRequest', project2, project2, 'a.rs', 'rust', 'textDocument/rename', { position: { line: 0, character: 3 }, newName: 'x' });
  await call('lsp', 'lspDisposeUnder', project2);
  process.env.PATH = emptyPath;
}
{
  const lsp = await M('language-server-manager');
  await rec('lsp', 'lspDocumentLanguageId', ['a.tsx', 'typescriptreact'], () => lsp.lspDocumentLanguageId('a.tsx', 'typescriptreact'));
  await rec('lsp', 'lspDocumentLanguageId', ['Dockerfile', 'plaintext'], () => lsp.lspDocumentLanguageId('Dockerfile', 'plaintext'));
  await rec('lsp', 'SERVER_BY_LANGUAGE', [], () => Object.fromEntries(Object.entries(lsp.SERVER_BY_LANGUAGE).map(([k, v]) => [k, { id: v.id, command: v.command, args: v.args }])));
}
// The pty keeps flushing output after termDispose; when those chunks arrive is the host's, so they are not LSP events.
corpora.lsp.push({ op: '<emitted events>', events: scrub(events.splice(0).filter((e) => !String(e?.name ?? '').startsWith('terminal'))) });
process.env.PATH = hostPath;
await ops.dispose();

// ---- notifications ------------------------------------------------------------------
{
  const nc = await M('notification-center');
  const { createNotificationPreferencesStore } = await M('notification-preferences');
  const clients = [
    { id: 'client-phone', name: 'Galaxy S24 · Mixdog App', platform: 'Android', browser: 'Mixdog App', online: true, createdAt: 1700000000000 },
    { id: 'client-web', name: 'Chrome · Browser', platform: 'Windows', browser: 'Chrome', online: false, createdAt: 1710000000000, alias: 'Office laptop' },
    { id: 'client-gone', name: 'Old · Browser', platform: 'iOS', browser: 'Safari', online: false, createdAt: 1, pendingRemoval: true },
  ];
  await rec('notifications', 'notificationDeviceName', clients.map((c) => c.id), () => clients.map((c) => nc.notificationDeviceName(c)));
  await rec('notifications', 'pairedDeviceInfo', clients.map((c) => c.id), () => clients.map((c) => nc.pairedDeviceInfo(c)));
  if (createNotificationPreferencesStore) {
    const sent = [];
    const center = nc.createNotificationCenter({
      store: createNotificationPreferencesStore({ filePath: join(userData, 'notification-preferences.json'), readLegacy: async () => [], now: () => 1_700_000_000_000 }),
      pcName: () => 'FIXTURE-PC',
      listClients: async () => clients,
      pushRegistrations: async () => new Set(['client-phone']),
      pcSupported: async () => true,
      sendPcTest: async () => { sent.push('pc'); return { ok: true }; },
      sendDeviceTest: async (id) => { sent.push(id); return { ok: id === 'client-phone', message: id === 'client-phone' ? undefined : 'no push registration' }; },
    });
    const run = (name, ...a) => rec('notifications', name, a, () => center.invoke(name, a));
    await run('notificationPreferencesState', 'pc', true);
    await run('setNotificationPreferences', 'pc', true, 'client-phone', { enabled: false });
    await run('setNotificationPreferences', 'pc', true, 'client-unknown', { enabled: false });
    await run('notificationPreferencesState', 'pc', true);
    await run('listConversationNotifications');
    await run('sendTestNotification', 'pc');
    await run('sendTestNotification', 'client-phone');
    await run('sendTestNotification', 'client-web');
    await run('sendTestNotification', 'client-gone');
    corpora.notifications.push({ op: '<sends>', sent });
  } else {
    corpora.notifications.push({ op: 'createNotificationCenter', error: 'notification preferences store module not found' });
  }
}

// ---- transfer (file downloads) -----------------------------------------------------------
{
  const dl = await M('file-downloads');
  const payload = Buffer.from('0123456789abcdef'.repeat(8));
  writeFileSync(join(project, 'report.bin'), payload);
  const SID = 'S'.repeat(43);
  const host = {
    listSessions: async () => [{ id: SID, classification: 'project', projectPath: project }],
    projectDirectory: async (p) => p,
    invokeCapability: async () => { throw new Error('no media'); },
    readSessionTranscript: async () => null, readSessionHistory: async () => null, readAttachmentImage: async () => null,
  };
  let clock = 1_700_000_000_000;
  const service = dl.createFileDownloadService({ host, now: () => clock });
  const dev = { deviceId: 'device-a' };
  const run = (op, input, fn) => rec('transfer', op, input, fn);
  let grant; let transfer;
  await run('requiredFileDownloadRequest', [{ source: { kind: 'project', sessionId: SID, relPath: 'report.bin' }, purpose: 'save' }], () => dl.requiredFileDownloadRequest({ source: { kind: 'project', sessionId: SID, relPath: 'report.bin' }, purpose: 'save' }));
  await run('requiredFileDownloadRequest', [{ source: { kind: 'project', sessionId: SID, relPath: '/abs' }, purpose: 'save' }], () => dl.requiredFileDownloadRequest({ source: { kind: 'project', sessionId: SID, relPath: '/abs' }, purpose: 'save' }));
  await run('authorize', ['project report.bin'], async () => { grant = await service.authorize(dev, { source: { kind: 'project', sessionId: SID, relPath: 'report.bin' }, purpose: 'save' }); return { ...grant, grantId: '<grant>' }; });
  await run('authorize(outside)', ['../x'], () => service.authorize(dev, { source: { kind: 'project', sessionId: SID, relPath: '../x' }, purpose: 'save' }));
  await run('begin', ['<grant>'], async () => { transfer = await service.begin(dev, grant.grantId); return { ...transfer, transferId: '<transfer>' }; });
  await run('begin(replay grant)', ['<grant>'], () => service.begin(dev, grant.grantId));
  await run('readRange', [0, 64], async () => { const c = await service.readRange(dev, transfer.transferId, 0, 64, transfer.version); return { ...c, dataSha: createHash64(c) }; });
  await run('readRange(other device)', [0, 8], () => service.readRange({ deviceId: 'device-b' }, transfer.transferId, 0, 8, transfer.version));
  await run('readRange(past end)', [1000, 8], () => service.readRange(dev, transfer.transferId, 1000, 8, transfer.version));
  await run('readRange(bad version)', [0, 8], () => service.readRange(dev, transfer.transferId, 0, 8, 'x'.repeat(43)));
  await run('finish', ['<transfer>'], () => service.finish(dev, transfer.transferId));
  await run('abort(unknown)', ['nope'], () => service.abort(dev, 'nope'));
  await run('begin(after expiry)', [], async () => { const g = await service.authorize(dev, { source: { kind: 'project', sessionId: SID, relPath: 'report.bin' }, purpose: 'open' }); clock += 24 * 3600 * 1000; return service.begin(dev, g.grantId); });
  await run('revokeDevice', ['device-a'], async () => { service.revokeDevice('device-a'); return true; });
  function createHash64(c) { return c?.data ? Buffer.from(c.data, typeof c.data === 'string' ? 'base64' : undefined).toString('base64').length : null; }
}

// ---- remote/relay device leg --------------------------------------------------------------
{
  const relayMod = await M('remote-relay');
  const frames = [];
  let handshakeHeaders = null;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: (info) => { handshakeHeaders = { path: info.req.url, headers: { ...info.req.headers } }; return true; } });
  const connected = new Promise((resolve) => wss.on('connection', (socket) => {
    socket.on('message', (d, bin) => frames.push({ dir: 'in', binary: bin, text: bin ? undefined : d.toString('utf8'), bytes: d.length }));
    resolve(socket);
  }));
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;
  const host = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : /^(subscribe|on|watch)/.test(String(prop)) ? () => () => {} : async () => (prop === 'listSessions' ? [] : null)) });
  let handle;
  await rec('remote-relay', 'startRemoteRelay', [`ws://127.0.0.1:<port>`], async () => {
    handle = await relayMod.startRemoteRelay({ relayUrl: `ws://127.0.0.1:${port}`, userDataPath: userData, host, appVersion: '0.0.0-fixture', hostName: () => 'FIXTURE-PC' });
    return { clientUrlShape: handle.clientUrl.replace(/\/d\/[^/]+\//, '/d/<deviceId>/').replace(String(port), '<port>'), tokenLength: handle.token.length, pairingKeys: Object.keys(handle.pairing ?? {}).sort(), clientCount: handle.clientCount };
  });
  if (handle) {
    const socket = await Promise.race([connected, sleep(8000).then(() => null)]);
    await sleep(1200);
    await rec('remote-relay', 'device-leg handshake', [], async () => ({ path: handshakeHeaders?.path?.replace(/[0-9a-f]{16,}/g, '<id>'), headerNames: Object.keys(handshakeHeaders?.headers ?? {}).sort(), authScheme: String(handshakeHeaders?.headers?.authorization ?? '').split(' ')[0] }));
    await rec('remote-relay', 'frames sent on open', [], async () => frames.map((f) => (f.text ? { dir: f.dir, text: f.text.length > 600 ? f.text.slice(0, 600) + '…' : f.text } : { dir: f.dir, binary: true, bytes: f.bytes })));
    await rec('remote-relay', 'listClients', [], () => handle.listClients());
    await rec('remote-relay', 'pairCode(ensure)', [], async () => { const p = handle.pairCode('ensure'); return p && { keys: Object.keys(p).sort(), codeShape: String(p.code ?? '').replace(/\d/g, '9') }; });
    await rec('remote-relay', 'pairCode(release)', [], () => handle.pairCode('release'));
    await rec('remote-relay', 'pushRegistrations', [], async () => [...(await handle.pushRegistrations())]);
    await rec('remote-relay', 'sendTestNotification(unknown)', ['nope'], () => handle.sendTestNotification('nope'));
    await rec('remote-relay', 'viewsSessionLane', ['s', 'lane'], async () => handle.viewsSessionLane('s', 'lane'));
    await rec('remote-relay', 'close', [], async () => { await handle.close(); return 'closed'; });
    socket?.terminate();
  }
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(r));
}

// ---- write -------------------------------------------------------------------------------
const outRoot = join(FIXTURES_ROOT, 'desktop');
const written = [];
for (const [domain, entries] of Object.entries(corpora)) {
  writeJson(join(outRoot, domain, 'corpus.json'), { domain, recorder: 'record-desktop-services.mjs', entries });
  written.push(`${domain}:${entries.length}`);
}
writeSetManifest(outRoot, { set: 'desktop', recorder: 'benchmarks/rust-core/recorders/record-desktop.mjs + record-desktop-services.mjs', command: 'see benchmarks/rust-core/README.md', extra: { serviceDomains: written } });
rmSync(work, { recursive: true, force: true });
console.log(written.join(' '));
process.exit(0);
