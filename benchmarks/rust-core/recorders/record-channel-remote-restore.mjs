#!/usr/bin/env node
// The boot restore of a persisted Remote pin through Node's real daemon wiring: `createChannelTransport` with the
// `handleCall` daemon.mjs:896 gives it (`createChannelsRuntimeLoader(...).handleCall` over the real channels runtime,
// whose `activate_channel_bridge` is runtime/channels/lib/tool-dispatch.mjs), then `restoreRemoteIntent()` as
// daemon.mjs:1288 calls it after ready. Two pins: a session whose transcript exists, and one whose session was deleted
// (no transcript, no session record). Date.now is frozen; nothing sleeps or polls.
//
//   node benchmarks/rust-core/recorders/record-channel-remote-restore.mjs --tree <exact export of b6f10295a with node_modules> [--out <file>]
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
const loader = createChannelsRuntimeLoader({ log: () => {}, setOwnerContext: () => {} });

const work = fs.mkdtempSync(join(SCRATCH, 'restore-'));
const fileState = (path) => (fs.existsSync(path) ? { kind: 'file', text: fs.readFileSync(path, 'utf8') } : { kind: 'absent' });

async function restoreCase(name, sessionId, transcriptExists) {
  const dir = fs.mkdtempSync(join(work, 'case-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  const transcriptPath = `/work/${sessionId}.jsonl`;
  if (transcriptExists) fs.writeFileSync(join(dir, `${sessionId}.jsonl`), '');
  fs.writeFileSync(intentPath, JSON.stringify({ version: 1, sessionId, transcriptPath, cwd: '/work', updatedAt: 123 }));
  const calls = [];
  const logs = [];
  const transport = createChannelTransport({
    remoteIntentPath: intentPath,
    log: (line) => logs.push(line),
    handleCall: async (callName, callArgs, ctx) => {
      const answer = await loader.handleCall(callName, callArgs, ctx);
      calls.push({ name: callName, args: callArgs, answer });
      return answer;
    },
  });
  const checkpoint = (at) => ({ at, pinnedSession: transport.remoteIntentSessionId, remoteSession: transport.remoteSessionId, file: fileState(intentPath) });
  const boot = checkpoint('boot');
  const restored = await within('restore', transport.restoreRemoteIntent());
  const after = checkpoint('restored');
  await within('transport stop', transport.stop());
  return { name, sessionId, transcriptExists, restored, calls, logs: logs.filter((line) => /^(channel )?remote intent /.test(line)), checkpoints: [boot, after] };
}

const cases = [
  await restoreCase('a pinned session that exists', 'sess_live', true),
  await restoreCase('a pinned session that was deleted', 'sess_deleted', false),
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
    command: `node ${recorder} --tree <tree>`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url),
      exclusions: [
        'logs keeps only the lines starting "remote intent " or "channel remote intent ", as channel-remote-intent does',
        'calls keeps the name, arguments and answer of handleCall, not its third argument (the HTTP client registry context)',
      ],
    },
  });
  commitStage(stage, finalDir);
}
try { await (await loader.ensure()).stop(); } catch {}
process.exit(0);
