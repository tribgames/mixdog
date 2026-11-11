#!/usr/bin/env node
// Which terminal output reaches which paired phone at the Node baseline (b6f10295a): the desktop service's real relay leg, client table,
// relay push lanes (remote-relay-push-lanes.ts) and terminal manager (a real ConPTY shell, the machine's default profile), a scripted relay
// and two real E2EE phones that read the terminal lane (`setRemoteLanes`). Per world:
//   - a tab the desktop opens: does each phone get its output from the tab's first output on, before either phone does anything about it;
//   - a tab one phone opens (`termEnsure`, then its keystrokes): does the other phone get its output from the first output on;
//   - an unpair of the first phone's device (`remoteAccessRevokeClient`) that the relay refuses, or confirms with the phone's socket still
//     open: does terminal output written after it still reach the unpaired phone.
// A phone's output "from the first output on" is its text for the tab starting with the tab's own text (the terminal manager's replay
// buffer, `termSnapshot`) up to the end of the marker the script typed; the shells' own text is never part of the recording.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs
//     benchmarks/rust-core/recorders/record-terminal-lane-reach.mjs --tree <git archive of b6f10295a with node_modules>
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { withJob } from './lib/process-job.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { assertNoPowerShellProfile, isolatedProfile } from './lib/shell-isolation.mjs';
import { LANE_REACH_CREDENTIALS, LANE_REACH_MARKS, LANE_REACH_TABS, reachOf } from './lib/terminal-lane-reach.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-terminal-lane-reach.mjs';
const TRACE_START = '@@REACH@@';
const TRACE_END = '@@END@@';
/** The whole recording, both worlds, in its own process and job. */
const RECORDING_MS = 4 * 60_000;
/** One wait for something the product sends. */
const UNTIL_DEADLINE_MS = 60_000;

const args = parseArgs();
const tree = resolveTree(args);

if (!args.has('child')) {
  // The recording runs in a process of its own (the shells' profile folder is its environment) inside a job, so the shells and the
  // ConPTY hosts it starts end with it on every path.
  const profile = mkdtempSync(join(tmpdir(), 'terminal-lane-reach-profile-'));
  let ran;
  try {
    const env = { ...process.env, ...isolatedProfile(profile) };
    assertNoPowerShellProfile(env);
    const here = fileURLToPath(import.meta.url);
    const hook = pathToFileURL(join(REPO_ROOT, 'benchmarks', 'rust-core', 'recorders', 'lib', 'ts-register.mjs')).href;
    ran = await withJob('the terminal lane reach recording', ({ run }) =>
      run('the recording', process.execPath, ['--experimental-transform-types', '--import', hook, here, '--tree', tree, '--child'], { cwd: REPO_ROOT, env, ms: RECORDING_MS })
    );
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  const end = ran.stdout.indexOf(TRACE_END);
  if (ran.timedOut || ran.code !== 0 || end < 0) throw new Error(`the recording failed (exit ${ran.code}${ran.timedOut ? `, not within ${RECORDING_MS} ms` : ''}):\n${ran.stdout.slice(-2000)}\n${ran.stderr.slice(-4000)}`);
  const worlds = JSON.parse(ran.stdout.slice(ran.stdout.lastIndexOf(TRACE_START, end) + TRACE_START.length, end));
  const finalDir = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'terminal-lane-reach');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), {
    note: 'Node (b6f10295a): per world, whether each paired phone reading the terminal lane got a tab\'s output from the tab\'s first output on (a tab the desktop opened, a tab the other phone opened), and whether output written after an unpair of the first phone (refused by the relay, or confirmed with its socket still open) reached that phone. See the recorder\'s header.',
    credentials: LANE_REACH_CREDENTIALS,
    tabs: LANE_REACH_TABS,
    marks: LANE_REACH_MARKS,
    worlds,
  });
  writeSetManifest(stage, {
    set: 'terminal-lane-reach',
    recorder: RECORDER,
    command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${RECORDER} --tree <git archive of ${REF} with node_modules>`,
    identity: exactProductIdentity(tree, REF),
    extra: {
      ...recorderProvenance(import.meta.url),
      compared:
        'Each world\'s values whole. A phone\'s output is compared only as whether it starts with the tab\'s own text up to the typed marker\'s output (and, after the unpair, whether it holds the marker): the shell\'s text and the frames\' cuts are the shell\'s and the 16 ms window\'s, not the lanes\'.',
      leftProcesses: `${ran.left} process(es) of the recording were still running when it ended; any are ended with its job.`,
    },
  });
  commitStage(stage, finalDir);
  console.log(`terminal-lane-reach: ${worlds.length} worlds`);
  process.exit(0);
}

const changes = new EventEmitter();
changes.setMaxListeners(0);
/** Resolves when `predicate` holds, looked at again on each frame that arrives; fails naming `what` after UNTIL_DEADLINE_MS. */
const until = (predicate, what) =>
  new Promise((resolve, reject) => {
    const check = () => {
      if (!predicate()) return;
      clearTimeout(timer);
      changes.off('change', check);
      resolve();
    };
    const timer = setTimeout(() => {
      changes.off('change', check);
      reject(new Error(`nothing arrived within ${UNTIL_DEADLINE_MS} ms: ${what}`));
    }, UNTIL_DEADLINE_MS);
    changes.on('change', check);
    check();
  });

const { WebSocketServer } = createRequire(join(tree, 'package.json'))('ws');
const { createDesktopService } = await importFrom(tree, 'apps/desktop/src/main/desktop-service.ts');
const { activateRemote } = await importFrom(tree, 'apps/desktop/src/main/remote-activation.ts');
const { loadOrCreateRelayE2EEIdentity } = await importFrom(tree, 'apps/desktop/src/main/remote-e2ee.ts');
const { relayE2EEPairingMaterial, createRelayE2EEClientHandshake } = await importFrom(tree, 'apps/desktop/src/shared/remote-e2ee.ts');
const { viewSyncHost } = await importFrom(tree, 'apps/desktop/src/main/test-support/view-sync-host.mjs');

async function world(relayConfirms) {
  const f = await viewSyncHost();
  const dir = f.options.userDataPath;
  const cwd = mkdtempSync(join(tmpdir(), 'terminal-lane-reach-cwd-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const previousUrl = process.env.MIXDOG_RELAY_URL;
  process.env.MIXDOG_RELAY_URL = `ws://127.0.0.1:${server.address().port}`;
  // The relay's roster: a confirmed unpair removes the device from it (the socket's close is held: the window this records).
  const roster = new Set(Object.values(LANE_REACH_CREDENTIALS));
  let leg = null;
  const fromDesktop = [];
  server.on('connection', (socket) => {
    leg = socket;
    socket.send(JSON.stringify({ type: 'relay-capabilities', textFrames: 1, maxFrameBytes: 1048576 }));
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      fromDesktop.push(frame);
      if (frame.type === 'revoke-client') {
        if (relayConfirms) roster.delete(frame.clientId);
        socket.send(JSON.stringify({ type: 'client-revoked', requestId: frame.requestId, ok: relayConfirms, ...(relayConfirms ? {} : { error: 'The relay could not unpair the device.' }) }));
      }
      if (frame.type === 'list-clients') {
        socket.send(JSON.stringify({ type: 'clients-list', requestId: frame.requestId, clients: [...roster].map((id) => ({ id, name: id, browser: 'Chrome' })) }));
      }
      changes.emit('change');
    });
  });
  let service;
  try {
    await activateRemote(dir);
    service = await createDesktopService({
      options: f.options,
      runtime: { ...f.runtime, loadConfig: async () => ({ readConfig: () => ({}) }) },
      emit: () => undefined,
    });
    const invoke = (operation, ...a) => service.invoke('invokeDesktopOperation', [operation, a]);
    await invoke('remoteAccessStart');
    await until(() => fromDesktop.some((frame) => frame.type === 'set-client-token'), 'the desktop leg is up');
    const pairing = relayE2EEPairingMaterial(await loadOrCreateRelayE2EEIdentity(dir));
    const phones = new Map();
    leg.on('message', (raw) => {
      const envelope = JSON.parse(String(raw));
      const phone = phones.get(envelope.clientId);
      if (!phone) return;
      if (envelope.type === 'close-client') {
        phone.closedByDesktop = envelope.reason ?? '';
        changes.emit('change');
      }
      if (envelope.type !== 'frame') return;
      phone.queue = phone.queue.then(async () => {
        if (!phone.channel) {
          const handshake = await createRelayE2EEClientHandshake(pairing, JSON.parse(envelope.data));
          phone.channel = handshake.channel;
          leg.send(JSON.stringify({ type: 'frame', clientId: phone.id, data: JSON.stringify(handshake.hello) }));
          return;
        }
        phone.messages.push(await phone.channel.decryptJson(envelope.data));
        changes.emit('change');
      });
    });
    let next = 100;
    const openPhone = async (id, credential) => {
      const phone = { id, messages: [], channel: null, queue: Promise.resolve(), closedByDesktop: null };
      phones.set(id, phone);
      leg.send(JSON.stringify({ type: 'client-open', clientId: id, browserClientId: credential }));
      await until(() => phone.messages.length > 0, `the phone ${id} is established`);
      const send = async (frame) => leg.send(JSON.stringify({ type: 'frame', clientId: id, data: await phone.channel.encryptJson(frame) }));
      return {
        call: async (method, params) => {
          const callId = next++;
          await send({ id: callId, method, params });
          await until(() => phone.messages.some((m) => m.id === callId), `the reply to the phone ${id}'s ${method}`);
          return phone.messages.find((m) => m.id === callId);
        },
        // Keystrokes: a frame without an id, which Node answers with nothing.
        fire: (method, params) => send({ method, params }),
        text: (tab) =>
          phone.messages
            .filter((m) => m.event === 'termData' && m.payload?.id === tab)
            .map((m) => m.payload.data)
            .join(''),
        phone,
      };
    };
    const p1 = await openPhone('p1', LANE_REACH_CREDENTIALS.p1);
    const p2 = await openPhone('p2', LANE_REACH_CREDENTIALS.p2);
    for (const phone of [p1, p2]) await phone.call('setRemoteLanes', [['terminal']]);
    const both = (tab, seen) => until(() => [p1, p2].every((phone) => phone.text(tab).includes(seen)), `both phones to get ${seen} on ${tab}`);
    const reach = async (tab, seen) => {
      const { text } = await invoke('termSnapshot', tab);
      return { p1: reachOf(text, p1.text(tab), seen), p2: reachOf(text, p2.text(tab), seen) };
    };

    // A tab the desktop opens and types into: neither phone asks anything about it.
    await invoke('termEnsure', LANE_REACH_TABS.desktop, cwd, null);
    await invoke('termWrite', LANE_REACH_TABS.desktop, LANE_REACH_MARKS.desktop.typed);
    await both(LANE_REACH_TABS.desktop, LANE_REACH_MARKS.desktop.seen);
    const desktopTab = await reach(LANE_REACH_TABS.desktop, LANE_REACH_MARKS.desktop.seen);

    // A tab the second phone opens and types into; the first phone asks nothing about it.
    await p2.call('termEnsure', [LANE_REACH_TABS.phone, cwd, null]);
    await p2.fire('termWrite', [LANE_REACH_TABS.phone, LANE_REACH_MARKS.phone.typed]);
    await both(LANE_REACH_TABS.phone, LANE_REACH_MARKS.phone.seen);
    const phoneTab = await reach(LANE_REACH_TABS.phone, LANE_REACH_MARKS.phone.seen);

    // The first phone's device is unpaired; its socket stays open. Output written after it reaches the second phone; whether the first
    // phone got it is read once a call of the first phone is answered: its frames come in the order the PC sent them, and the output's
    // frame to it was sent with the second phone's.
    await invoke('remoteAccessRevokeClient', LANE_REACH_CREDENTIALS.p1).catch(() => undefined);
    await invoke('termWrite', LANE_REACH_TABS.desktop, LANE_REACH_MARKS.unpair.typed);
    await until(() => p2.text(LANE_REACH_TABS.desktop).includes(LANE_REACH_MARKS.unpair.seen), `the second phone to get ${LANE_REACH_MARKS.unpair.seen}`);
    await p1.call('termProfiles', []);
    const unpair = {
      unpairedPhoneGotOutput: p1.text(LANE_REACH_TABS.desktop).includes(LANE_REACH_MARKS.unpair.seen),
      desktopClosedUnpairedPhone: p1.phone.closedByDesktop,
    };
    for (const tab of Object.values(LANE_REACH_TABS)) await invoke('termDispose', tab);
    return { name: relayConfirms ? 'the relay confirms the unpair, the socket still open' : 'the relay refuses the unpair', relayConfirms, desktopTab, phoneTab, unpair };
  } finally {
    await service?.dispose();
    leg?.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (previousUrl === undefined) delete process.env.MIXDOG_RELAY_URL;
    else process.env.MIXDOG_RELAY_URL = previousUrl;
    await f.close?.();
  }
}

const worlds = [await world(false), await world(true)];
process.stdout.write(`\n${TRACE_START}${JSON.stringify(worlds)}${TRACE_END}\n`);
process.exit(0);
