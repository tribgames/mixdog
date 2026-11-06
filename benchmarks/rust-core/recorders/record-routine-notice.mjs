#!/usr/bin/env node
// Genuine 1.4.5 restored routine / task-report notices: stored result messages
// (`routineResultMessage`, `agentTaskMessage`, ...) and the rows `restoreTranscriptItems`
// shows for them, with the `routine` payload and the attachment fields
// `routineResultNotice` carries. The Rust restore (`transcript_rows.rs`,
// `routine_notice_fields`) must give the same rows (`routine_notices_equal_nodes`).
//
//   node benchmarks/rust-core/recorders/record-routine-notice.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/migration/routine-notice/cases.json
import { join } from 'node:path';
import {
  FIXTURES_ROOT,
  commitStage,
  importFrom,
  parseArgs,
  resolveTree,
  stageSet,
  writeJson,
  writeSetManifest,
} from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const { restoreTranscriptItems } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs');
const { agentTaskMessage, routineResultMessage, routineOmittedMessage, agentTaskRelayFailedMessage } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/session/routine-result.mjs'
);

const id = 'a'.repeat(64);
const files = [
  { name: 'report.pdf', path: '/tmp/report.pdf', kind: 'file', mimeType: 'application/pdf', size: 2048, id },
  { name: 'big.bin', path: '/tmp/big.bin', size: -5 },
  { path: '' },
  { name: 'odd', path: '/tmp/odd', kind: 'weird', id: 'not-an-id' },
];
const at = 1000;
const cases = [
  { name: 'a finished task report with stored files', message: agentTaskMessage({ title: 'Build', status: 'completed', text: 'done', taskSessionId: 'sess_task_1', files, at, messageId: 'routine_t1' }) },
  { name: 'a started task', message: agentTaskMessage({ title: 'Build', status: 'started', taskSessionId: 'sess_task_2', at, messageId: 'routine_t2' }) },
  { name: 'a progress update keeps its line', message: agentTaskMessage({ title: 'Build', status: 'working', text: '\n  first line\nsecond', taskSessionId: 'sess_task_3', at, messageId: 'routine_t3' }) },
  { name: 'a session report answering several sends', message: agentTaskMessage({ title: 'Ask', status: 'failed', text: 'no', taskSessionId: 'sess_task_4', target: 'session', sendId: 's1', sendIds: ['s1', 's2'], hop: 2, at, messageId: 'routine_t4' }) },
  { name: 'a bot home task report names its agent', message: agentTaskMessage({ title: 'Ping', status: 'completed', text: 'pong', taskSessionId: 'sess_home_bot1', sendIds: ['only'], at, messageId: 'routine_t5' }) },
  { name: 'a completed schedule', message: routineResultMessage({ name: 'daily', ok: true, text: 'all good', runId: 'r1', runSessionId: 'rs1', at, messageId: 'routine_r1' }) },
  { name: 'a failed webhook that paused its endpoint', message: routineResultMessage({ kind: 'webhook', name: 'hook', ok: false, text: 'boom', reason: 'http_500', paused: true, at, messageId: 'routine_r2' }) },
  { name: 'older results omitted', message: routineOmittedMessage({ count: 3, at, messageId: 'routine_o1' }) },
  { name: 'a relay that failed', message: agentTaskRelayFailedMessage({ count: 2, tries: 3, at, messageId: 'routine_f1' }) },
].map((c) => ({
  name: c.name,
  message: c.message,
  rows: restoreTranscriptItems([c.message], { sessionId: 'rn' }),
}));

const finalOut = join(FIXTURES_ROOT, 'migration', 'routine-notice');
const stage = stageSet(finalOut);
writeJson(join(stage, 'cases.json'), { note: 'stored routine/task notices and their restored rows', cases });
writeSetManifest(stage, {
  set: 'migration/routine-notice',
  recorder: 'benchmarks/rust-core/recorders/record-routine-notice.mjs',
  command: 'node benchmarks/rust-core/recorders/record-routine-notice.mjs --tree <tree>',
  extra: { cases: cases.length },
});
commitStage(stage, finalOut);
console.log(`cases=${cases.length}`);
