#!/usr/bin/env node
// The boot restore of a persisted Remote pin through Node's real daemon wiring: `createChannelTransport` with the
// `handleCall`, `onRemoteStateChange` and (patched tree) `sessionExists` daemon.mjs gives it
// (`createChannelsRuntimeLoader(...).handleCall` over the real channels runtime, whose `activate_channel_bridge` is
// runtime/channels/lib/tool-dispatch.mjs; the stored-session views over the real session store), then
// `restoreRemoteIntent()` as daemon.mjs calls it after ready. Three pins: a stored session that exists (the control),
// one whose session record was deleted while the pin stayed, and one whose record cannot be read. The restore's whole
// visible effect in b6f10295a is the binding (no process delivers a channel's inbound message to a session, and there
// is no bot send: see the manifest), so after each restore the binding is read back as a client reads it: the intent
// file, the transport's pin, and `session.list` of the real `createSessionService` over the stored views, whose
// `remoteSession` is the state `onRemoteStateChange` published.
// Date.now is frozen; nothing sleeps or polls.
//
//   node benchmarks/rust-core/recorders/record-channel-remote-restore.mjs --tree <b6f10295a export with node_modules> [--patch <file>] [--out <file>]
//
// Output: native/core/fixtures/channel-remote-restore/golden.json (+ MANIFEST.json), or only the result at --out.
import fs from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, within, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-channel-remote-restore.mjs';
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:/mixdog-build/tmp/w23/rec';
const FROZEN = 1_700_000_000_000;
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const out = args.get('out') ?? null;

fs.mkdirSync(SCRATCH, { recursive: true });
const dataDir = fs.mkdtempSync(join(SCRATCH, 'data-')).replaceAll('\\', '/');
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dataDir,
  MIXDOG_HOME: dataDir,
  MIXDOG_RUNTIME_ROOT: fs.mkdtempSync(join(SCRATCH, 'rt-')).replaceAll('\\', '/'),
  MIXDOG_DAEMON_HOST: '1',
  MIXDOG_RELAY_URL: 'ws://127.0.0.1:9',
});
Date.now = () => FROZEN;

const { createChannelTransport } = await importFrom(tree, 'src/standalone/channel-transport.mjs');
const { createChannelsRuntimeLoader } = await importFrom(tree, 'src/standalone/daemon-channels-loader.mjs');
const { createDesktopRuntime } = await importFrom(tree, 'src/standalone/daemon-desktop-runtime.mjs');
const { createStoredSessionViews } = await importFrom(tree, 'src/standalone/daemon-stored-session-views.mjs');
const { createSessionService } = await importFrom(tree, 'src/standalone/session-service.mjs');
const loader = createChannelsRuntimeLoader({ log: () => {}, setOwnerContext: () => {} });
// daemon.mjs: the stored-session views over the desktop runtime's real session store.
const desktopRuntime = createDesktopRuntime({ getLocalSessionBridge: () => null });
const storedSessionViews = createStoredSessionViews({ desktopRuntime, dataDir });

const work = fs.mkdtempSync(join(SCRATCH, 'restore-'));
const sessionsDir = join(dataDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const fileState = (path) => (fs.existsSync(path) ? { kind: 'file', text: fs.readFileSync(path, 'utf8') } : { kind: 'absent' });
// A stored session record as the store keeps it (the legacy json the cold reader addresses).
const writeSession = (id) =>
  fs.writeFileSync(
    join(sessionsDir, `${id}.json`),
    JSON.stringify({ id, owner: 'user', agent: 'lead', closed: false, generation: 1, updatedAt: 1, title: `Session ${id}`, provider: 'p', model: 'm', messages: [{ role: 'user', content: 'hello' }] })
  );

async function restoreCase(name, sessionId, record) {
  const dir = fs.mkdtempSync(join(work, 'case-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  // The pin a manual Remote ON saved for a stored session; a deletion afterwards removes the record, not the pin.
  writeSession(sessionId);
  fs.writeFileSync(intentPath, JSON.stringify({ version: 1, sessionId, transcriptPath: `/work/${sessionId}.jsonl`, cwd: '/work', updatedAt: 123 }));
  if (record === 'deleted') fs.rmSync(join(sessionsDir, `${sessionId}.json`));
  // A record that is there but cannot be read (a torn write): no proof the session is gone.
  if (record === 'unreadable') fs.writeFileSync(join(sessionsDir, `${sessionId}.json`), '{"id":"' + sessionId + '","messages":[');
  const calls = [];
  const logs = [];
  let remoteSessionState = { enabled: false, sessionId: null };
  const transport = createChannelTransport({
    remoteIntentPath: intentPath,
    log: (line) => logs.push(line),
    handleCall: async (callName, callArgs, ctx) => {
      const answer = await loader.handleCall(callName, callArgs, ctx);
      calls.push({ name: callName, args: callArgs, answer });
      return answer;
    },
    onRemoteStateChange: (state) => {
      remoteSessionState = { enabled: state?.enabled === true, sessionId: state?.sessionId ?? null, cwd: state?.cwd ?? null };
    },
    ...(identity.patch ? { sessionPresence: (id) => storedSessionViews.sessionPresence(id) } : {}),
  });
  const checkpoint = (at) => ({ at, pinnedSession: transport.remoteIntentSessionId, remoteSession: transport.remoteSessionId, file: fileState(intentPath) });
  const boot = checkpoint('boot');
  const restored = await within('restore', transport.restoreRemoteIntent());
  const after = checkpoint('restored');

  // list: the client's session list.
  const service = createSessionService({
    createSessionRuntime: async () => { throw new Error('the list never materializes a session'); },
    ...storedSessionViews,
    getRemoteSessionState: () => remoteSessionState,
    desktopRuntime,
  });
  const listed = await service.handleCall('session.list', {});
  const list = { sessions: listed.sessions.map((row) => row.id), remoteSession: listed.remoteSession };
  await service.methods?.stop?.();

  await within('transport stop', transport.stop());
  return {
    name,
    sessionId,
    record,
    restored,
    calls,
    logs: logs.filter((line) => /^(channel )?remote intent /.test(line)),
    checkpoints: [boot, after],
    list,
  };
}

const cases = [
  await restoreCase('a pinned session that exists', 'sess_live', 'live'),
  await restoreCase('a pinned session that was deleted', 'sess_deleted', 'deleted'),
  await restoreCase('a pinned session whose record cannot be read', 'sess_unreadable', 'unreadable'),
];
fs.rmSync(work, { recursive: true, force: true });
const result = { frozenNow: FROZEN, cases };

if (out) {
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
} else {
  const finalDir = join(FIXTURES_ROOT, 'channel-remote-restore');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), result);
  writeSetManifest(stage, {
    set: 'channel-remote-restore',
    recorder,
    command: `node ${recorder} --tree <tree>${identity.patch ? ` --patch ${identity.patch.file}` : ''}`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url),
      exclusions: [
        'logs keeps only the lines starting "remote intent " or "channel remote intent ", as channel-remote-intent does',
        'calls keeps the name, arguments and answer of handleCall, not its third argument (the HTTP client registry context)',
        'no inbound delivery is recorded: in b6f10295a no process delivers a channel inbound message to a session. The channels runtime runs only in the daemon, whose notify sink hands the channel method to createChannelSessionRouter (standalone/daemon.mjs:924-933) with getSessionId always null; the router then logs "unavailable" and returns true (session-runtime/services/channel-session-router.mjs:10-18), so transport.notify (standalone/channel-transport/remote-notify.mjs:24), the SSE path to a session runtime\'s onNotify (session-runtime/boot/tools.mjs:161-169), is never reached for it',
        'no bot send is recorded: b6f10295a has none; the channels runtime dispatches only activate_channel_bridge, reload_config and rename_schedule (runtime/channels/lib/tool-dispatch.mjs:29-96; session-runtime/services/channel-worker.mjs:21)',
        'so the restore\'s whole visible effect is the binding: the checkpoints, the logs and session.list remoteSession (a binding to a session the list does not show is the defect the patch removes)',
        'list: the session ids and remoteSession of session.list; remoteSession keeps enabled, sessionId and cwd (daemonPid and updatedAt are the process and the clock)',
      ],
    },
  });
  commitStage(stage, finalDir);
}
try { await (await loader.ensure()).stop(); } catch {}
process.exit(0);
