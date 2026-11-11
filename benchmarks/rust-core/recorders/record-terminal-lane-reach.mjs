#!/usr/bin/env node
// What each paired phone reading (or not reading) the terminal lane receives at the Node baseline (b6f10295a): the desktop service's real
// relay leg, client table, relay push lanes (remote-relay-push-lanes.ts, its 16 ms TerminalDataBufferer) and terminal manager, a scripted
// relay and three real E2EE phones. Each tab's shell is the scripted shell (lib/scripted-pty.mjs in place of node-pty, the program the
// core's replay mode runs over pipes): it writes back each typed line in one write, so a phone's messages hold exactly what was typed.
// Per world, in order:
//   - p1 and p2 read the terminal lane, p3 reads no lane;
//   - a tab the desktop opens, typed into: its first output;
//   - a tab p2 opens (`termEnsure`) and types into;
//   - p2 leaves the lane, the desktop tab writes, p2 comes back, the desktop tab writes again;
//   - p3 joins the lane while the desktop tab is mid-output (it has written three lines), and the tab writes;
//   - a tab whose shell ends by itself (`@exit 3`) while all three read, then its dispose;
//   - the tab p2 opened writes, and p2 disposes it while its shell runs: the last output and the exit line that follows;
//   - an unpair of p1's device (`remoteAccessRevokeClient`) that the relay refuses, or confirms with the phone's socket still open, and
//     output after it.
// Recorded per phone: every terminal-lane push it received (termData, termActivity, termSizeOwner), each in its own order, whole, through
// `exact`; for each termData the relay envelope's `droppable` (what Node let the relay drop for a phone that cannot take it); whether the
// desktop closed the phone. Every step waits for what it sent to reach each phone reading the lane, and a phone that does not read is
// asked a call whose answer comes after anything the step sent it, before the next step: one typed line is one chunk and one frame
// (see the manifest's `framing`), so the split into messages is Node's and the same on every run.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs
//     benchmarks/rust-core/recorders/record-terminal-lane-reach.mjs --tree <git archive of b6f10295a with node_modules> [--only <world>]
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { exact } from './lib/exact.mjs';
import { withJob } from './lib/process-job.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { assertNoPowerShellProfile, isolatedProfile } from './lib/shell-isolation.mjs';
import { LANE_EVENTS, LANE_REACH_CREDENTIALS, LANE_REACH_TABS, KILLED_EXIT_NORMALISED, echoed, normaliseKilledExit, typed } from './lib/terminal-lane-reach.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-terminal-lane-reach.mjs';
const TRACE_START = '@@REACH@@';
const TRACE_END = '@@END@@';
/** The whole recording, both worlds, in its own process and job. */
const RECORDING_MS = 4 * 60_000;
/** One wait for something the product sends. */
const UNTIL_DEADLINE_MS = 60_000;
/** The worlds: the relay refuses the unpair, or confirms it with the phone's socket still open. */
const WORLDS = { refused: false, confirmed: true };
/** Loaded by the recording besides its imports: the PTY stand-in and its resolve hook. */
const STAND_IN = ['benchmarks/rust-core/recorders/lib/scripted-pty-hooks.mjs', 'benchmarks/rust-core/recorders/lib/scripted-pty.mjs'];

const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only');
if (only !== undefined && !(only in WORLDS)) throw new Error(`--only takes one of ${Object.keys(WORLDS).join(', ')}`);

if (!args.has('child')) {
  // The recording runs in a process of its own (the shells' profile folder is its environment) inside a job, so the scripted shells it
  // starts end with it on every path.
  const profile = mkdtempSync(join(tmpdir(), 'terminal-lane-reach-profile-'));
  let ran;
  try {
    const env = { ...process.env, ...isolatedProfile(profile) };
    assertNoPowerShellProfile(env);
    const here = fileURLToPath(import.meta.url);
    const hook = pathToFileURL(join(REPO_ROOT, 'benchmarks', 'rust-core', 'recorders', 'lib', 'ts-register.mjs')).href;
    ran = await withJob('the terminal lane reach recording', ({ run }) =>
      run('the recording', process.execPath, ['--experimental-transform-types', '--import', hook, here, '--tree', tree, '--child', ...(only ? ['--only', only] : [])], { cwd: REPO_ROOT, env, ms: RECORDING_MS })
    );
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  const end = ran.stdout.indexOf(TRACE_END);
  if (ran.timedOut || ran.code !== 0 || end < 0) throw new Error(`the recording failed (exit ${ran.code}${ran.timedOut ? `, not within ${RECORDING_MS} ms` : ''}):\n${ran.stdout.slice(-2000)}\n${ran.stderr.slice(-4000)}`);
  const worlds = JSON.parse(ran.stdout.slice(ran.stdout.lastIndexOf(TRACE_START, end) + TRACE_START.length, end));
  if (only) {
    // One world is a check of the recorder, never a recording.
    console.log(JSON.stringify(worlds, null, 1));
    process.exit(0);
  }
  const finalDir = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'terminal-lane-reach');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), {
    note: "Node (b6f10295a): per world, every terminal-lane push each paired phone received, per kind in order and whole (exact), each termData with its relay envelope's `droppable`, and whether the desktop closed the phone. See the recorder's header for the steps.",
    credentials: LANE_REACH_CREDENTIALS,
    tabs: LANE_REACH_TABS,
    worlds,
  });
  writeSetManifest(stage, {
    set: 'terminal-lane-reach',
    recorder: RECORDER,
    command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${RECORDER} --tree <git archive of ${REF} with node_modules>`,
    identity: exactProductIdentity(tree, REF),
    extra: {
      ...recorderProvenance(import.meta.url, STAND_IN),
      values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
      entry:
        "Ran: Node's desktop service (createDesktopService) with its relay leg dialling a scripted relay (relay-capabilities, roster, revoke-client answers), three phones through the relay with the app's own E2EE handshake, `setRemoteLanes`, `termEnsure`, `termWrite`, `termDispose`, `termProfiles` as the phones' calls, and the desktop's own `termEnsure`, `termWrite`, `termDispose`, `remoteAccessRevokeClient`. The PTY is the scripted shell (lib/scripted-pty.mjs through lib/scripted-pty-hooks.mjs): node-pty's ConPTY is not run, and the terminal manager's own code runs on what the shell writes. Not run: a direct (WebRTC) transport; binary relay frames (the relay offers text frames).",
      replay:
        "apps/desktop/src/renderer/remote-protocol-terminal-lanes.slow.test.mjs (benchmarks/rust-core/recorders/lib/terminal-lane-reach-replay.mjs): mixdogd built with `--features \"terminal-lease-clock replay-controls\"` and started with MIXDOG_TERMINAL_SCRIPTED_SHELL=1 (mixdog-spawn `scripted-shell`: every tab runs crate::scripted::profile over pipes), dialling a scripted relay; the desktop over `terminal/ensure`, `terminal/input`, `terminal/dispose`, `remoteAccess/revokeClient`; each phone the page's own terminal adapter (remote-protocol-terminal.ts) and lane feeds (apps/mobile/src/phone-lanes.ts) over the protocol client through the relay. Each phone's termData, termActivity and termSizeOwner events (what the adapter hands the page) are compared whole with Node's, each in its own order; each termData's envelope `droppable` is that of the relay frame that carried its `process/outputDelta` on the terminal lane feed.",
      compared:
        "Each world's values whole, per phone and per kind of push in order: every termData (tab id and text, exactly) with its envelope `droppable`, every termActivity and termSizeOwner, and whether the desktop closed the phone. Not compared: the interleaving of the kinds with each other (termData goes through the relay lane's 16 ms buffer, the others at once: remote-relay-push-lanes.ts:80-89 against :139-150), and the `droppable` of termActivity and termSizeOwner (Node sends both never droppable, :139-150; the core's come from its sections, which do not carry a phone frame of their own).",
      framing:
        "Not on a virtual clock, and not needed: every step waits until what it sent reached every phone reading the lane before the next output is written, so the relay buffer holds one chunk at a time; a chunk with nothing waiting is sent at once or after its 16 ms as one frame of its own (terminal-data-buffer.ts:41-58 and :62-87: `flush` sends the joined pending chunks, and the push lane acknowledges each frame as it sends it, remote-relay-push-lanes.ts:83-88, so no high watermark holds any back), and the scripted shell writes each line back in one write over a pipe, one chunk. So one typed line is one termData message on every run, whatever the timing. How the buffer joins chunks that arrive within 16 ms is recorded on a virtual clock in apps/mobile/fixtures/relay-framing and replayed by mixdog-spawn service::relay_buffer.",
      slowPhone:
        "Node's desktop sends every termData to the relay marked `droppable` (remote-relay-push-lanes.ts:85, remote-relay-delivery.ts:131-140) and keeps nothing per phone: a phone that cannot take it is the relay's to skip, with a resync hint, never closed (apps/relay/lib/relay-legs.mjs:304-319 deliverToPhone, relay-transport.mjs:717-733 sendToPhone and admitFrame :308-313; a frame not droppable over a leg's budget cuts the leg). The desktop's memory for it is the relay socket's send buffer, shared by every phone, which one slow phone does not fill: the relay never pauses the desktop's socket for one consumer (relay-legs.mjs:512-516). Recorded: each termData's `droppable`.",
      normalised: [
        {
          path: `worlds[*].phones.*.termData[*].payload.data where payload.id is ${LANE_REACH_TABS.phone}`,
          value: KILLED_EXIT_NORMALISED,
          reason:
            "The exit code in the exit line of the tab p2 disposes while its shell runs: it is how each side's stand-in ends the scripted program (Node's: libuv's TerminateProcess, 1; the core's pipe-run tab: its job, 137), not the product's. With a real console both sides' shell ends with its own STATUS_CONTROL_C_EXIT (apps/mobile/fixtures/phone-terminal). The exit line's place and the rest of its text are compared.",
        },
      ],
      leftProcesses: `${ran.left} process(es) of the recording were still running when it ended; any are ended with its job.`,
    },
  });
  commitStage(stage, finalDir);
  console.log(`terminal-lane-reach: ${worlds.length} worlds`);
  process.exit(0);
}

register('./lib/scripted-pty-hooks.mjs', import.meta.url);

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
        const message = await phone.channel.decryptJson(envelope.data);
        phone.messages.push(message);
        if (message.event === 'termData') phone.got.termData.push({ payload: message.payload, droppable: envelope.droppable });
        else if (LANE_EVENTS.includes(message.event)) phone.got[message.event].push({ payload: message.payload });
        changes.emit('change');
      });
    });
    let next = 100;
    const openPhone = async (id, credential) => {
      const phone = { id, messages: [], got: Object.fromEntries(LANE_EVENTS.map((event) => [event, []])), channel: null, queue: Promise.resolve(), closedByDesktop: null };
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
          phone.got.termData
            .filter((entry) => entry.payload?.id === tab)
            .map((entry) => entry.payload.data)
            .join(''),
        phone,
      };
    };
    const p1 = await openPhone('p1', LANE_REACH_CREDENTIALS.p1);
    const p2 = await openPhone('p2', LANE_REACH_CREDENTIALS.p2);
    const p3 = await openPhone('p3', LANE_REACH_CREDENTIALS.p3);
    const all = { p1, p2, p3 };
    const reading = new Set();
    const lanes = async (name, read) => {
      await all[name].call('setRemoteLanes', [read ? ['terminal'] : []]);
      if (read) reading.add(name);
      else reading.delete(name);
    };
    /** `text` reached every phone reading the lane on `tab`; each other phone has had a call answered after it was sent. */
    const reached = async (tab, text) => {
      await until(() => [...reading].every((name) => all[name].text(tab).includes(text)), `${[...reading].join(', ')} to get ${JSON.stringify(text)} on ${tab}`);
      for (const name of Object.keys(all)) if (!reading.has(name)) await all[name].call('termProfiles', []);
    };
    const desktopTypes = async (tab, line) => {
      await invoke('termWrite', tab, typed(line));
      await reached(tab, echoed(line));
    };
    const EXITED = '[process exited with code';
    await lanes('p1', true);
    await lanes('p2', true);
    await lanes('p3', false);

    // A tab the desktop opens and types into: no phone asks anything about it.
    await invoke('termEnsure', LANE_REACH_TABS.desktop, cwd, null);
    await desktopTypes(LANE_REACH_TABS.desktop, 'lane-desk-1');

    // A tab p2 opens and types into; p1 asks nothing about it.
    await p2.call('termEnsure', [LANE_REACH_TABS.phone, cwd, null]);
    await p2.fire('termWrite', [LANE_REACH_TABS.phone, typed('lane-ph-1')]);
    await reached(LANE_REACH_TABS.phone, echoed('lane-ph-1'));

    // p2 leaves the lane and comes back; the desktop tab writes while it is away and after.
    await lanes('p2', false);
    await desktopTypes(LANE_REACH_TABS.desktop, 'lane-desk-2');
    await lanes('p2', true);
    await desktopTypes(LANE_REACH_TABS.desktop, 'lane-desk-3');

    // p3 joins while the desktop tab is mid-output.
    await lanes('p3', true);
    await desktopTypes(LANE_REACH_TABS.desktop, 'lane-desk-4');

    // A tab whose shell ends by itself while all three read, then its dispose.
    await invoke('termEnsure', LANE_REACH_TABS.ends, cwd, null);
    await desktopTypes(LANE_REACH_TABS.ends, 'lane-end-1');
    await invoke('termWrite', LANE_REACH_TABS.ends, typed('@exit 3'));
    await reached(LANE_REACH_TABS.ends, EXITED);
    await invoke('termDispose', LANE_REACH_TABS.ends);
    for (const phone of Object.values(all)) await phone.call('termProfiles', []);

    // The tab p2 opened writes, and p2 disposes it while its shell runs.
    await p2.fire('termWrite', [LANE_REACH_TABS.phone, typed('lane-ph-2')]);
    await reached(LANE_REACH_TABS.phone, echoed('lane-ph-2'));
    await p2.call('termDispose', [LANE_REACH_TABS.phone]);
    await reached(LANE_REACH_TABS.phone, EXITED);
    for (const phone of Object.values(all)) await phone.call('termProfiles', []);

    // p1's device is unpaired; its socket stays open. What p1 got of the output after it is read once a call of p1 is answered.
    await invoke('remoteAccessRevokeClient', LANE_REACH_CREDENTIALS.p1).catch(() => undefined);
    reading.delete('p1');
    await desktopTypes(LANE_REACH_TABS.desktop, 'lane-desk-5');

    const phonesGot = normaliseKilledExit(
      Object.fromEntries(Object.entries(all).map(([name, { phone }]) => [name, { ...exact(phone.got), closedByDesktop: exact(phone.closedByDesktop) }])),
      LANE_REACH_TABS.phone
    );
    await invoke('termDispose', LANE_REACH_TABS.desktop);
    return { name: relayConfirms ? 'the relay confirms the unpair, the socket still open' : 'the relay refuses the unpair', relayConfirms, phones: phonesGot };
  } finally {
    await service?.dispose();
    leg?.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (previousUrl === undefined) delete process.env.MIXDOG_RELAY_URL;
    else process.env.MIXDOG_RELAY_URL = previousUrl;
    await f.close?.();
  }
}

const worlds = [];
for (const [name, confirms] of Object.entries(WORLDS)) if (!only || only === name) worlds.push(await world(confirms));
process.stdout.write(`\n${TRACE_START}${JSON.stringify(worlds)}${TRACE_END}\n`);
process.exit(0);
