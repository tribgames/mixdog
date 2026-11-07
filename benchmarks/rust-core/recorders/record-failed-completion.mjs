#!/usr/bin/env node
// Golden twin of a failed turn's recorded end: Node's REAL `turnFailureRecord` (session/turn-failure.mjs, what
// `failedTurnCompletion` of manager/ask-turn-failure.mjs spreads into `meta.transcript.completion`) for plain
// errors on a fixed route. Rust `mixdog-core-session` `failure_record` must answer the same for the same message.
// Isolated env (temp data dir / home), no user data.
//
//   node benchmarks/rust-core/recorders/record-failed-completion.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const work = mkdtempSync(join(tmpdir(), 'record-failed-completion-'));
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
const tree = resolveTree(parseArgs());
const { turnFailureRecord } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/turn-failure.mjs');

const route = { provider: 'anthropic', model: 'm' };
const messages = [
  'boom',
  'Error: already prefixed',
  'error : spaced prefix',
  'Cancelled by user',
  'Search failed: network down',
  'No first response from the provider',
  'The request failed: Authorization: Bearer abcdef0123456789abcdef',
  'line one\nline two',
  `long ${'x'.repeat(400)}`,
  '',
];
const cases = messages.map((message) => {
  const { errorKind, quota, detail, errorDetails } = turnFailureRecord(new Error(message), route);
  return { message, route, errorKind, quota, detail, errorDetails };
});
writeJson(join(FIXTURES_ROOT, 'failed-completion', 'golden.json'), { cases });
writeSetManifest(join(FIXTURES_ROOT, 'failed-completion'), {
  set: 'failed-completion',
  recorder: 'benchmarks/rust-core/recorders/record-failed-completion.mjs',
  command: 'node benchmarks/rust-core/recorders/record-failed-completion.mjs --tree <tree>',
  identityTree: tree,
});
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${cases.length} failure records`);
process.exit(0);
