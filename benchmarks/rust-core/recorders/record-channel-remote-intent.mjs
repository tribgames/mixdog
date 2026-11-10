#!/usr/bin/env node
// The durable Remote pin of Node's channel transport (`channel-remote-intent.json`): what `readRemoteIntent` makes of
// each file content (src/standalone/channel-binding.mjs), and what the REAL `createChannelTransport` does with it at boot
// (`restoreRemoteIntent`, called by daemon.mjs:1289 after ready) and on a manual Remote ON/OFF over its HTTP `/call`
// (call-dispatch.mjs -> remote-intent.mjs). `handleCall` is the recorder's: it records each call and answers as the
// scenario says, the seam Node's own tests use. Date.now is frozen, so every `updatedAt` Node writes is FROZEN.
// The I/O-error cases replace fs.readFileSync for the intent path only, as channel-binding.test.mjs does.
//
//   node benchmarks/rust-core/recorders/record-channel-remote-intent.mjs --tree <exact export of b6f10295a with node_modules> [--only <case>]
//
// Output: native/core/fixtures/channel-remote-intent/golden.json (+ MANIFEST.json). With --only, the one case is printed
// and nothing is written.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIXTURES_ROOT,
  commitStage,
  exactProductIdentity,
  importFrom,
  parseArgs,
  recordingProvenance,
  resolveTree,
  stageSet,
  within,
  writeJson,
  writeSetManifest,
} from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-channel-remote-intent.mjs';
const FROZEN = 1_700_000_000_000;
Date.now = () => FROZEN;

const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only') ?? null;
const { readRemoteIntent } = await importFrom(tree, 'src/standalone/channel-binding.mjs');
const { createChannelTransport } = await importFrom(tree, 'src/standalone/channel-transport.mjs');

const work = fs.mkdtempSync(join(tmpdir(), 'record-channel-remote-intent-'));
const saved = (over = {}) =>
  JSON.stringify({ version: 1, sessionId: 'sess_saved', transcriptPath: '/work/sess_saved.jsonl', cwd: '/work', updatedAt: 123, ...over });
const fileState = (path) => {
  if (!fs.existsSync(path)) return { kind: 'absent' };
  if (fs.statSync(path).isDirectory()) return { kind: 'directory' };
  return { kind: 'file', text: fs.readFileSync(path, 'utf8') };
};

// readRemoteIntent over one file content. `content` null: no file; {directory:true}: a directory (EISDIR, a real
// non-ENOENT failure); {error}: the read throws that code.
const READS = [
  ['valid', saved()],
  ['valid without cwd', JSON.stringify({ version: 1, sessionId: 'sess_saved', transcriptPath: '/work/sess_saved.jsonl', updatedAt: 5 })],
  ['valid with null cwd', saved({ cwd: null })],
  ['valid with numeric cwd', saved({ cwd: 7 })],
  ['valid without updatedAt', JSON.stringify({ sessionId: 'sess_saved', transcriptPath: '/work/sess_saved.jsonl', cwd: '/work' })],
  ['updatedAt as a numeric string', saved({ updatedAt: '456' })],
  ['updatedAt zero', saved({ updatedAt: 0 })],
  ['updatedAt not a number', saved({ updatedAt: 'soon' })],
  ['padded session and transcript', saved({ sessionId: '  sess_saved ', transcriptPath: ' /work/sess_saved.jsonl\n' })],
  ['transcript with two extensions', saved({ sessionId: 'sess_saved.jsonl', transcriptPath: '/work/sess_saved.jsonl.bak' })],
  ['transcript without extension', saved({ transcriptPath: '/work/sess_saved' })],
  ['transcript with a trailing slash', saved({ transcriptPath: '/work/sess_saved.jsonl/' })],
  ['numeric session id', JSON.stringify({ sessionId: 42, transcriptPath: '/work/42.jsonl' })],
  ['extra keys dropped', saved({ ownerLeadPid: 99, extra: true })],
  ['absent', null],
  ['invalid JSON', '{'],
  ['non-object content', 'null'],
  ['an array', '[1]'],
  ['missing transcript', JSON.stringify({ sessionId: 'sess_saved' })],
  ['invalid session id', JSON.stringify({ sessionId: '../other', transcriptPath: 'other.jsonl' })],
  ['mismatched transcript', JSON.stringify({ sessionId: 'sess_saved', transcriptPath: 'sess_other.jsonl' })],
  ['empty session id', saved({ sessionId: '' })],
  ['a byte order mark', `\ufeff${saved()}`],
  ['NUL-filled', '\0\0\0\0'],
  ['empty file', ''],
  ['a directory', { directory: true }],
  ['EACCES', { error: 'EACCES' }],
  ['EBUSY', { error: 'EBUSY' }],
  ['EIO', { error: 'EIO' }],
];

function recordRead(name, content) {
  const dir = fs.mkdtempSync(join(work, 'read-'));
  const path = join(dir, 'channel-remote-intent.json');
  if (typeof content === 'string') fs.writeFileSync(path, content);
  else if (content?.directory) fs.mkdirSync(path);
  else if (content?.error) fs.writeFileSync(path, saved());
  const before = fileState(path);
  const originalRead = fs.readFileSync;
  if (content?.error) {
    fs.readFileSync = (target, ...rest) => {
      if (target === path) throw Object.assign(new Error(`binding read failed: ${content.error}`), { code: content.error });
      return originalRead(target, ...rest);
    };
    syncBuiltinESMExports();
  }
  let result;
  try {
    result = { intent: readRemoteIntent(path) };
  } catch (error) {
    result = { threw: error.code };
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
  return { name, before, ...result, after: fileState(path) };
}

// One transport over one runtime root. `calls` and `logs` are what Node's transport handed its handleCall and its log.
async function withTransport(setup, answer, run) {
  const dir = fs.mkdtempSync(join(work, 'transport-'));
  const intentPath = join(dir, 'channel-remote-intent.json');
  if (typeof setup === 'string') fs.writeFileSync(intentPath, setup);
  else if (setup?.directory) fs.mkdirSync(intentPath);
  const calls = [];
  const logs = [];
  const transport = createChannelTransport({
    remoteIntentPath: intentPath,
    log: (line) => logs.push(line),
    handleCall: async (name, callArgs) => {
      calls.push({ name, args: callArgs });
      return answer(name, callArgs);
    },
  });
  const checkpoints = [];
  const checkpoint = (at) =>
    checkpoints.push({ at, pinnedSession: transport.remoteIntentSessionId, remoteSession: transport.remoteSessionId, file: fileState(intentPath) });
  checkpoint('boot');
  let outcome;
  try {
    outcome = await run(transport, checkpoint);
  } finally {
    await within('transport stop', transport.stop());
  }
  // Only the intent's own lines: the listener, client registry and pointer lines are the HTTP transport's, which the
  // core does not have (its clients are WebSocket connections).
  const intentLogs = logs.filter((line) => /^(channel )?remote intent /.test(line));
  return { ...outcome, calls, logs: intentLogs, checkpoints };
}

async function post(endpoint, path, body) {
  const response = await within(
    `POST ${path}`,
    fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mixdog-daemon-token': endpoint.token },
      body: JSON.stringify(body),
    })
  );
  return response.json();
}

async function manual(transport, callArgs) {
  const endpoint = await within('transport start', transport.start());
  const client = await post(endpoint, '/client/register', { leadPid: process.pid, passive: true });
  return post(endpoint, '/call', { token: client.token, name: 'activate_channel_bridge', args: callArgs });
}

const ok = () => ({ content: [{ type: 'text', text: 'channel bridge activated' }] });
const restore = async (transport, checkpoint) => {
  const restored = await within('restore', transport.restoreRemoteIntent());
  checkpoint('restored');
  return restored;
};
const TRANSPORT = {
  'boot restores the saved session': () =>
    withTransport(saved(), ok, async (t, c) => ({ restored: await restore(t, c) })),
  'boot restore answered with a soft error': () =>
    withTransport(saved(), () => ({ isError: true, content: [{ type: 'text', text: 'bridge unavailable' }] }), async (t, c) => ({ restored: await restore(t, c) })),
  'boot restore whose call fails': () =>
    withTransport(saved(), () => { throw new Error('boom'); }, async (t, c) => ({ restored: await restore(t, c) })),
  'boot without an intent': () => withTransport(null, ok, async (t, c) => ({ restored: await restore(t, c) })),
  'boot with an invalid intent': () => withTransport('{', ok, async (t, c) => ({ restored: await restore(t, c) })),
  'boot with an unreadable intent': () => withTransport({ directory: true }, ok, async (t, c) => ({ restored: await restore(t, c) })),
  'a second restore after the first': () =>
    withTransport(saved(), ok, async (t, c) => ({ restored: [await restore(t, c), await restore(t, c)] })),
  'manual ON then OFF': () =>
    withTransport(null, ok, async (t, c) => {
      await manual(t, { active: true, sessionId: 'sess_on', transcriptPath: '/work/sess_on.jsonl' });
      c('on');
      await manual(t, { active: false, sessionId: 'sess_on' });
      c('off');
      return {};
    }),
  'manual ON over a restored session': () =>
    withTransport(saved(), ok, async (t, c) => {
      const restored = await restore(t, c);
      await manual(t, { active: true, sessionId: 'sess_on', transcriptPath: '/work/sess_on.jsonl' });
      c('on');
      return { restored };
    }),
  'manual ON whose transcript names another session': () =>
    withTransport(saved(), ok, async (t, c) => {
      await manual(t, { active: true, sessionId: 'sess_on', transcriptPath: '/work/other.jsonl' });
      c('on');
      return {};
    }),
  'manual ON without a transcript': () =>
    withTransport(null, ok, async (t, c) => {
      await manual(t, { active: true, sessionId: 'sess_on' });
      c('on');
      return {};
    }),
  'manual ON answered with a soft error': () =>
    withTransport(null, () => ({ isError: true, content: [{ type: 'text', text: 'no' }] }), async (t, c) => {
      await manual(t, { active: true, sessionId: 'sess_on', transcriptPath: '/work/sess_on.jsonl' });
      c('on');
      return {};
    }),
  'restore after a manual ON': () =>
    withTransport(null, ok, async (t, c) => {
      await manual(t, { active: true, sessionId: 'sess_on', transcriptPath: '/work/sess_on.jsonl' });
      c('on');
      return { restored: await restore(t, c) };
    }),
};

const names = [...READS.map(([name]) => name), ...Object.keys(TRANSPORT)];
if (only && !names.includes(only)) throw new Error(`no case named ${only}; cases: ${names.join(' | ')}`);
const reads = [];
for (const [name, content] of READS) if (!only || only === name) reads.push(recordRead(name, content));
const transport = [];
for (const [name, run] of Object.entries(TRANSPORT)) {
  if (only && only !== name) continue;
  transport.push({ name, ...(await run()) });
}
fs.rmSync(work, { recursive: true, force: true });

if (only) {
  console.log(JSON.stringify({ reads, transport }, null, 2));
  process.exit(0);
}
const identity = exactProductIdentity(tree, NODE_COMMIT);
const finalDir = join(FIXTURES_ROOT, 'channel-remote-intent');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { frozenNow: FROZEN, reads, transport });
writeSetManifest(stage, {
  set: 'channel-remote-intent',
  recorder,
  command: `node ${recorder} --tree <tree>`,
  identity,
  extra: {
    provenance: recordingProvenance(recorder, ['benchmarks/rust-core/recorders/lib/common.mjs']),
    exclusions: [
      'transport.logs keeps only the lines starting "remote intent " or "channel remote intent ": the listener, client-registry and pointer lines belong to the HTTP transport, which the core replaces with WebSocket connections',
      'a log line that ends in an OS error message (the unreadable intent) is compared up to that message: the text is the platform error of the runtime, not of the product',
      'transport.calls keeps the name and arguments handed to handleCall, not its third argument (client token, lead pid, cwd of the HTTP client registry)',
      'the HTTP replies of /call are not recorded: the core answers channel/call over its own wire',
    ],
  },
});
commitStage(stage, finalDir);
console.log(`recorded ${reads.length} reads and ${transport.length} transport cases`);
process.exit(0);
