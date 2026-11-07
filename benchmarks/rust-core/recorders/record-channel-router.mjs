#!/usr/bin/env node
// Golden twin of the channel session router: Node's REAL `stripSoftWarns` (tool-loop-guard.mjs), the REAL
// `injectAndRecord` (its source text sliced out of channels/lib/worker-main.mjs and evaluated over the real
// strip and the real parent bridge), the REAL `normalizeChannelNotifyParams` path of parent-bridge.mjs, the
// REAL `createChannelSessionRouter` / `channelNotificationModelContent`, and the REAL pending-message queue
// entry of a channel task notification. Isolated env (temp data dir / home), no user data.
// Rust `mixdog_app_server_daemon::channel_router` and `mixdog-core-session` `queue_channel_notification`
// must answer the same.
//
//   node benchmarks/rust-core/recorders/record-channel-router.mjs --tree <dir>
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const work = mkdtempSync(join(tmpdir(), 'record-channel-router-'));
for (const d of ['data', 'home', 'appdata', 'localappdata', 'backups']) mkdirSync(join(work, d), { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: join(work, 'data'),
  MIXDOG_HOME: join(work, 'home'),
  HOME: join(work, 'home'),
  USERPROFILE: join(work, 'home'),
  APPDATA: join(work, 'appdata'),
  LOCALAPPDATA: join(work, 'localappdata'),
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  MIXDOG_USER_DATA_BACKUP_ROOT: join(work, 'backups'),
  TZ: 'UTC',
});
const FROZEN = 1_700_000_000_000;
Date.now = () => FROZEN;
let entropy = 0;
crypto.randomBytes = (length) => Buffer.alloc(length, ++entropy);
syncBuiltinESMExports();

const tree = resolveTree(parseArgs());
const { stripSoftWarns } = await importFrom(tree, 'src/runtime/agent/orchestrator/tool-loop-guard.mjs');
const { createChannelSessionRouter } = await importFrom(tree, 'src/session-runtime/services/channel-session-router.mjs');
const { createParentBridge, setChannelNotifySink } = await importFrom(tree, 'src/runtime/channels/lib/parent-bridge.mjs');
const pending = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');

const NBSP = '\u00a0';
const strip = [
  'plain text', '', ' ', '⚠ Tool-loop(3 calls)\nrest', 'a\n⚠ Repeated-input(x)\nb', '⚠ Iteration(9) no newline',
  '⚠ Tool-loop soft-warn\nline\nmore\n\nafter', '⚠ Tool-loop soft-warn at end', '⚠ 0-match family-switch advisory\nx\n\ny', '⚠ 0-match ESCALATED\nz',
  `⚠${NBSP}Edit-miss(1)\nkept?`, '⚠\u2003Same-file multi-chunk(2)\nq', '⚠ Same-file   multi-chunk(2)\nq', '⚠\u0085Tool-loop(1)\nnel', '⚠\ufeffTool-loop(1)\nbom',
  '⚠ Unknown(1)\nstays', 'before ⚠ Mixed-tool(2) mid\nafter', '⚠ Bash file-lookup(1)\n⚠ Bash\u00a0file-lookup(2)\nend', '⚠ Tool-loop soft-warn\n \t \nafter blank',
].map((input) => ({ input, output: stripSoftWarns(input) }));

// The real injectAndRecord, sliced from worker-main.mjs.
const workerSource = readFileSync(join(tree, 'src/runtime/channels/lib/worker-main.mjs'), 'utf8');
const start = workerSource.indexOf('function injectAndRecord(');
const end = workerSource.indexOf('function wireWebhookHandlers');
if (start < 0 || end < start) throw new Error('injectAndRecord not found in worker-main.mjs');
const makeInject = new Function('stripSoftWarns', 'sendNotifyToParent', `${workerSource.slice(start, end)}\nreturn injectAndRecord;`);

const ok = (log) => ({ async submitSession(args) { log.submits.push(args); } });
const services = {
  ok,
  none: () => null,
  throws: (log) => ({ async submitSession(args) { log.submits.push(args); throw new Error('boom'); } }),
};
const injectCases = [
  { content: ' ', options: { type: 'webhook', instruction: 'PR opened' } },
  { content: ' ', options: { type: 'webhook', instruction: '  padded\n' } },
  { content: ' ', options: { type: 'webhook', instruction: '   ' } },
  { content: ' ', options: { type: 'webhook', instruction: '⚠ Tool-loop(3)\nkept in instruction' } },
  { content: ' ', options: { type: 'webhook', instruction: 'ci' }, lead: null },
  { content: ' ', options: { type: 'webhook', instruction: 'ci' }, service: 'none' },
  { content: ' ', options: { type: 'webhook', instruction: 'ci' }, service: 'throws' },
  { content: ' ', options: { type: 'webhook', instruction: 'ci' }, lead: '  sess_pad  ' },
  { content: 'plain body' },
  { content: '  body\n', options: { type: 'webhook' } },
  { content: '⚠ Tool-loop(3)\nkept body', options: { type: 'x' } },
  { content: '⚠ Tool-loop(3)\n', options: { type: 'x' } },
  { content: 'hello', options: { instruction: 'wins over content' } },
  { content: 'hello', options: { instruction: 'silent', silent_to_agent: true } },
  { content: 'hello', options: { silent_to_agent: false } },
  { content: '', options: {} },
];
const inject = [];
for (const c of injectCases) {
  const lead = 'lead' in c ? c.lead : 'sess_lead';
  const kind = c.service ?? 'ok';
  const log = { submits: [], logs: [] };
  const router = createChannelSessionRouter({
    getSessionId: () => lead,
    getSessionService: () => services[kind](log),
    log: (line) => log.logs.push(line),
  });
  setChannelNotifySink((method, params) => router(method, params));
  const bridge = createParentBridge({ getInstanceId: () => 'i' });
  makeInject(stripSoftWarns, bridge.sendNotifyToParent)(c.content, c.options);
  await new Promise((resolve) => setImmediate(resolve));
  inject.push({ content: c.content, options: c.options ?? null, lead, service: kind, submits: log.submits, logs: log.logs });
}
setChannelNotifySink(null);

// A channel task notification in the pending queue.
const SESSION = 'sess_c';
const queued = pending.enqueuePendingMessage(SESSION, { content: 'PR opened', mode: 'task-notification', origin: 'channel' });
const queue = { session: SESSION, returned: queued ?? null, entries: pending._getPendingMessagesForSession(SESSION) };
await pending.settlePendingMessageWrites();

writeJson(join(FIXTURES_ROOT, 'channel-router', 'golden.json'), { frozenNow: FROZEN, strip, inject, queue });
writeSetManifest(join(FIXTURES_ROOT, 'channel-router'), {
  set: 'channel-router',
  recorder: 'benchmarks/rust-core/recorders/record-channel-router.mjs',
  command: 'node benchmarks/rust-core/recorders/record-channel-router.mjs --tree <tree>',
  identityTree: tree,
});
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${strip.length} strip, ${inject.length} inject cases and ${queue.entries.length} queue entries`);
process.exit(0);
