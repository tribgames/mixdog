// Drives a RUNNING mixdogd through the cases of remote-protocol-chat-abort-cases.mjs, case for case as Node's recording
// (remote-protocol-chat-abort.record.mjs) drove its daemon, through the phone's own stack: one protocol client per paired device
// (packages/protocol-client `connect`, kind phone), the phone's router (remote-shim-protocol.ts) and its chat adapter
// (remote-protocol-chat.ts `adapter`, the production one). It returns what each phone was told: the reply to each of its calls, each
// change of the thread's state as the client folds it (`sessionStateOf`), each change of the thread's row in a roster the adapter
// published, in the order they happened; then the thread's items and its list row once the turn(s) closed.
//
// The binary is `MIXDOGD_EXE`, the real-turn harness directory `REAL_TURN_HARNESS`: a missing one fails, and so does a binary older than
// any source cargo built it from (`builtFrom`). Every wait is an event wait under one deadline that names what it waits for; nothing is
// retried; everything started is ended on every path.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from '../../../../packages/protocol-client/src/client.ts';
import { sessionReducer, sessionStateOf } from '../../../../packages/protocol-client/src/session-state.ts';
import { parseDiscovery } from '../main/protocol/discovery.ts';
import { createWsConnector } from '../main/protocol/ws-connector.ts';
import { ABORT_CASES, ASKED_PROJECT_FILE, DEVICES, HOOK_RULES, PROJECT_FILE } from './remote-protocol-chat-abort-cases.mjs';
import { startAbortProvider } from './remote-protocol-chat-abort-provider.mjs';

const REPO_ROOT = new URL('../../../../', import.meta.url);

/**
 * The sources the binary was built from, by cargo's own record of them (the dep-info `<binary stem>.d` beside it, every file the compile
 * read): a binary older than any of them, or one built from another checkout, is not the code under test and is refused.
 */
export function builtFrom(bin) {
  const depInfo = bin.replace(/\.exe$/i, '') + '.d';
  if (!existsSync(depInfo)) throw new Error(`${bin} has no dep-info ${depInfo}: build it with cargo (cargo-gate build -p mixdog-app-server-daemon --bin mixdogd)`);
  const text = readFileSync(depInfo, 'utf8');
  const listed = text.slice(text.indexOf(': ') + 2).split('\n')[0].trim();
  const sources = listed.split(/(?<!\\) /).map((path) => path.replaceAll('\\ ', ' ')).filter(Boolean);
  const root = decodeURIComponent(REPO_ROOT.pathname.replace(/^\/([A-Za-z]:)/, '$1')).replaceAll('/', '\\').toLowerCase();
  const built = statSync(bin).mtimeMs;
  const foreign = sources.filter((path) => path.toLowerCase().includes('\\native\\core\\crates\\') && !path.toLowerCase().startsWith(root));
  if (foreign.length) throw new Error(`${bin} was built from another checkout (${foreign[0]}), not ${root}`);
  const newer = sources.filter((path) => path.toLowerCase().startsWith(root) && (!existsSync(path) || statSync(path).mtimeMs > built));
  if (newer.length) throw new Error(`${bin} is older than ${newer.length} of its sources (e.g. ${newer.slice(0, 3).join(', ')}): rebuild it`);
  return { depInfo, sources: sources.filter((path) => path.toLowerCase().startsWith(root)).length };
}

/**
 * Ends the memory cluster the killed core left running: every postgres.exe run from this env's data folder (its runtime binary lives
 * there), the postmaster and its children. The harness's `killStrayPostgres` matches the pgdata path with backslashes, but pg_ctl starts
 * postgres with paths in forward slashes and a child's command line names only the binary, so it matched nothing and the next run's
 * folder removal hit EBUSY on pg.log.
 */
function killCluster(dataDir) {
  const forms = [dataDir, dataDir.replaceAll('\\', '/')].map((p) => `'*${p.replace(/'/g, "''")}*'`).join(', ');
  const script = `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object { $c = $_.CommandLine; @(${forms}) | Where-Object { $c -like $_ } } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 60_000 });
  if (out.status !== 0) throw new Error(`ending the memory cluster under ${dataDir} failed (${out.status ?? out.error}): ${out.stderr}`);
}

/** `only` names one case of ABORT_CASES to run alone; without it every case runs (what the test's full run compares). */
export async function runAbortLive({ only } = {}) {
  const chosen = only === undefined ? ABORT_CASES : ABORT_CASES.filter((c) => c.name === only);
  if (!chosen.length) throw new Error(`--only names no abort case: ${JSON.stringify(only)}`);
  const bin = process.env.MIXDOGD_EXE;
  const harness = process.env.REAL_TURN_HARNESS;
  if (!bin || !existsSync(bin)) throw new Error(`MIXDOGD_EXE must name the built mixdogd binary (got ${JSON.stringify(bin)})`);
  if (!harness || !existsSync(join(harness, 'lib', 'env.mjs'))) throw new Error(`REAL_TURN_HARNESS must name the real-turn harness directory (got ${JSON.stringify(harness)})`);
  const built = builtFrom(bin);
  process.env.HARNESS_ENV_ROOT = join(harness, 'run', 'env-ph2-chat-abort-live');
  const load = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
  const { daemonEnv, isolatedPaths } = await load('env.mjs');
  const { seedPgRuntime } = await load('stage.mjs');
  const { launch } = await load('proc.mjs');
  const { createDeadline, latch } = await load('deadline.mjs');

  const paths = isolatedPaths();
  rmSync(paths.envRoot, { recursive: true, force: true });
  for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
  const project = join(paths.workspace, 'a');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, PROJECT_FILE.name), PROJECT_FILE.text);
  writeFileSync(join(project, ASKED_PROJECT_FILE.name), ASKED_PROJECT_FILE.text);
  writeFileSync(join(paths.dataDir, 'hooks.json'), JSON.stringify(HOOK_RULES));
  seedPgRuntime(paths.dataDir);

  const notes = [];
  const told = [];
  let core;
  const clients = [];
  let watcher;
  let provider;
  let deadline = createDeadline(240_000, () => `${core?.tail() ?? '(core not started)'}\nnotifications: ${notes.slice(-12).map((n) => n.method).join(', ')}\nphone was told last: ${JSON.stringify(told.slice(-3)).slice(-4000)}\nlast row told: ${JSON.stringify(told.findLast((event) => event.kind === 'row') ?? null)}`);
  try {
    provider = await deadline.race(startAbortProvider(), 'the model endpoint to listen');
    writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
    const route = { provider: 'custom-harness', model: 'harness-model' };

    core = launch(bin, ['serve'], { env: daemonEnv(paths, { RUST_LOG: 'warn' }), cwd: paths.envRoot });
    const daemonDoc = () => {
      const file = join(paths.runtimeRoot, 'daemon.json');
      if (!existsSync(file)) return null;
      try {
        const d = JSON.parse(readFileSync(file, 'utf8'));
        return d?.core?.state === 'serving' && d.core.rpc?.port ? d : null;
      } catch { return null; }
    };
    const served = latch();
    watcher = watch(paths.runtimeRoot, () => { const d = daemonDoc(); if (d) served.resolve(d); });
    const early = daemonDoc();
    if (early) served.resolve(early);
    const doc = await deadline.race(served.promise, 'the core to serve');

    const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
    // The router arms a per-call deadline on the page's window timers; this run has its own deadline, so the page's never fires.
    globalThis.window ??= { setTimeout: () => 0, clearTimeout() {} };
    const { adapter } = await import('./remote-protocol-chat.ts');
    const { createProtocolRouter } = await import('./remote-shim-protocol.ts');
    const endpoint = parseDiscovery(readFileSync(join(paths.runtimeRoot, 'daemon.json'), 'utf8'));
    // What each phone was told, in order (the same three kinds Node's recording keeps): a reply to one of its calls, a change of a thread's
    // state as its client folds it, a change of a thread's row in a roster its adapter published. Equal consecutive values are no change.
    const waiters = new Set();
    const wake = () => { for (const check of [...waiters]) check(); };
    // One phone per paired device: its own client (the core stamps a prompt and a Stop with the connection's `clientInfo.title`), router and adapter.
    const connectPhone = async (title) => {
      const client = await deadline.race(connect({
        target: { id: 'core' },
        connector: createWsConnector(async () => endpoint),
        // The device a decision is stamped with is the paired device's name, which the relay's pairing gives a phone connection; this
        // run connects without the relay, so it names the device as a local client does, by its title (the core stamps that).
        clientInfo: { name: 'mixdog-phone', title, version: '1.4.5', kind: 'tui' },
        capabilities: { optOutNotificationMethods: [], experimentalApi: false },
        threadReducer: sessionReducer,
        // The client sleeps only on its reconnect ladder after a dropped transport; this run never drops one, and a drop fails it.
        clock: { sleep: () => Promise.reject(new Error('the phone dropped its connection')) },
        random: Math.random,
      }), `the client of ${title} to connect`);
      clients.push(client);
      const lastState = new Map();
      const lastRow = new Map();
      client.on((event) => {
        if (event.type === 'notification') notes.push({ method: event.notification.method, params: event.notification.params, device: title });
        wake();
      });
      client.store.subscribe((change) => {
        if (change.type === 'thread') {
          const snapshot = plain(sessionStateOf(client, change.threadId));
          const key = JSON.stringify(snapshot);
          if (lastState.get(change.threadId) !== key) {
            lastState.set(change.threadId, key);
            told.push({ device: title, sessionId: change.threadId, kind: 'state', snapshot });
          }
        }
        wake();
      });
      const ctx = {
        phone: { start: async () => undefined },
        sessionsCatalog: {
          publish: (rows) => {
            const listed = new Map(rows.map((row) => [row.id, row]));
            for (const id of new Set([...lastRow.keys(), ...listed.keys()])) {
              const row = listed.has(id) ? plain(listed.get(id)) : null;
              if (JSON.stringify(row) === JSON.stringify(lastRow.get(id) ?? null)) continue;
              lastRow.set(id, row);
              told.push({ device: title, sessionId: id, kind: 'row', row });
            }
            wake();
          },
        },
      };
      const router = createProtocolRouter([adapter], {
        host: { ctx, client: () => client, declareLane() {} },
        started: async () => undefined,
        synced: async () => undefined,
        probe() {},
        silentSince: () => false,
      });
      router.install();
      // The phone's view opens the app feed first (apps/mobile/src/phone-view.ts `attach`): the roster's edges arrive on it.
      await deadline.race(client.subscribeApp(), `the app feed of ${title}`);
      // The page's boot read of the list (remote-shim-api.ts listSessions): the roster the adapter publishes edges onto from then on.
      await deadline.race(router.call('listSessions', []), `the first list read of ${title}`);
      const phoneCall = async (method, args) => {
        const sessionId = method === 'submitNewTask' ? undefined : args[0];
        let reply;
        try {
          reply = plain(await deadline.race(router.call(method, args), `the reply of ${title} to ${method}`));
        } catch (error) {
          told.push({ device: title, sessionId, kind: 'reply', method, error: String(error?.message ?? error) });
          throw error;
        }
        told.push({ device: title, sessionId: sessionId ?? reply?.sessionId, kind: 'reply', method, reply });
        return reply;
      };
      return { client, call: phoneCall, list: () => router.call('listSessions', []) };
    };
    const until = (ready, what) => {
      const done = latch();
      const check = () => { if (ready()) { waiters.delete(check); done.resolve(); } };
      waiters.add(check);
      check();
      return deadline.race(done.promise, what);
    };
    // What the submitting device's connection was told (it holds the thread open); the other device only sends its Stop.
    let viewer = '';
    const seen = (id, method, text) => notes.filter((n) => n.device === viewer && n.method === method && n.params?.threadId === id && (text === undefined || JSON.stringify(n.params).includes(text))).length;
    const phones = new Map();
    const phone = async (title) => {
      if (!phones.has(title)) phones.set(title, await connectPhone(title));
      return phones.get(title);
    };

    const cases = [];
    for (const c of chosen) {
      const submitter = await phone(c.submitter ?? DEVICES.a);
      const canceller = await phone(c.canceller ?? c.submitter ?? DEVICES.a);
      const mark = notes.length;
      viewer = c.submitter ?? DEVICES.a;
      const toldFrom = told.length;
      const since0 = Date.now();
      // The phone's own calls, with the arguments Node's recording gave its phone table.
      const submit = { id: `sub-${c.name}`, ...(c.pasted ? { pastedTexts: c.pasted } : {}), ...(c.submit ?? {}) };
      const accepted = await submitter.call('submitNewTask', [c.prompt, submit, { projectPath: project, route }]);
      const id = accepted.sessionId;
      const state = () => sessionStateOf(submitter.client, id);
      // As Node's recording waits (`closed`): the thread's state counts the case's turns and no turn runs.
      const turns = c.then ? 2 : 1;
      const closed = () => state()?.stats?.turns === turns && state()?.busy === false;
      if (c.ready === 'completed') await until(closed, `the turn of ${c.name} to end on its own`);
      else if (c.ready === 'approval' || c.ready === 'ask') {
        await deadline.race(provider.asked(c.prompt), `the model endpoint to receive the tool-calling turn of ${c.name}`);
        // As Node's recording waits: the approval is pending and the call's card is shown.
        await until(() => state()?.toolApproval && state()?.items?.some((item) => item?.kind === 'tool'), `the tool approval of ${c.name} to be pending with its card shown`);
      } else await deadline.race(provider.held(c.prompt), `the model endpoint to receive the held turn of ${c.name}`);
      if (c.output) await until(() => JSON.stringify(state() ?? {}).includes(c.output), `the streamed text of ${c.name} to reach the phone`);
      if (c.then) {
        await submitter.call('submitToSession', [id, c.then, { id: `sub-${c.name}-2` }]);
        await until(() => JSON.stringify(state() ?? {}).includes(c.then), `the queued prompt of ${c.name} to reach the phone`);
      }
      const answers = [];
      let shownId;
      for (const [n, step] of (c.notify ?? []).entries()) {
        // 'shown' is the approval the phone was shown when it first answered one: a later answer goes to the same approval.
        const approvalId = step.id === 'shown' ? (shownId ??= String(state()?.toolApproval?.id ?? '')) : step.id;
        if (!approvalId) throw new Error(`${c.name}: no approval is shown for notification answer ${n}`);
        answers.push(await submitter.call('answerApprovalNotification', [id, approvalId, step.action]));
      }
      const stopAt = Date.now();
      let reply = null;
      if (c.stop) reply = await canceller.call('abortSession', [id, c.stop]);
      await until(closed, `the turn(s) of ${c.name} to close${c.stop ? ' after its Stop' : ''}`);
      // As Node's recording waits: a runtime's prompt the Stop put back runs again, up to the model's request.
      if (c.requeued) await deadline.race(provider.held(c.prompt, 2), `the model endpoint to receive the second, requeued turn of ${c.name}`);
      const second = c.again ? await canceller.call('abortSession', [id, c.again]) : undefined;
      // As Node's recording reads the row: once the phone holds the one the turn's close stamped.
      const stampedAfter = c.ready === 'completed' || !c.stop ? since0 : stopAt;
      const rowOf = () => told.findLast((event) => event.device === viewer && event.kind === 'row' && event.sessionId === id)?.row;
      await until(() => (rowOf()?.updatedAt ?? 0) >= stampedAfter, `the thread row of ${c.name} stamped by its close to be published`);
      // What the turn left, whole, read at the same moment on both surfaces the phone reads: the thread's items and its list row.
      const read = await deadline.race(submitter.client.call('thread/read', { threadId: id, window: { lastItems: 200 } }), `thread/read after ${c.name}`);
      const row = (await deadline.race(submitter.list(), `listSessions after ${c.name}`)).find((r) => r.id === id) ?? null;
      const promptRestore = plain(state()?.promptRestore ?? null);
      const stream = told.slice(toldFrom).filter((event) => event.sessionId === id && event.device === viewer || (event.kind === 'reply' && event.sessionId === id)).map(({ sessionId: _s, device, ...event }) => (event.kind === 'reply' ? { ...event, device } : event));
      cases.push({ name: c.name, id, core: { reply, ...(second ? { second } : {}), ...(c.notify ? { answers } : {}), items: read.items, row, promptRestore, stream } });
    }    return {
      manifest: {
        binary: bin, binarySha256: createHash('sha256').update(readFileSync(bin)).digest('hex'), binaryBuilt: statSync(bin).mtime.toISOString(), builtFrom: built,
        source: 'running mixdogd serve, isolated env (real-turn harness env.mjs / stage.mjs / proc.mjs), model endpoint remote-protocol-chat-abort-provider.mjs, driven through the phone\'s router and chat adapter over the protocol client',
      },
      cases,
    };
  } finally {
    deadline.clear();
    const ended = createDeadline(60_000, () => `ending the abort run; core: ${core?.tail()}`);
    try {
      watcher?.close();
      for (const client of clients) client.close?.();
      try {
        if (core) {
          core.kill();
          await ended.race(core.exited, 'the core to exit');
        }
      } finally {
        try {
          if (provider) await ended.race(provider.close(), 'the model endpoint to close');
        } finally {
          killCluster(paths.dataDir);
        }
      }
    } finally {
      ended.clear();
    }
  }
}
