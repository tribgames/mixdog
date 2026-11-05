// Records what the Node poller (`shellJobsStatusFresh` of statusline-segments.mjs) reports for
// a scripted life of shell jobs, into shell-jobs.json, the golden file tests/tasks_ports.rs
// replays against `TaskRegistry`. Time is virtual (Date.now is replaced), so the 30-minute
// retention is exercised exactly. Run from the repository root:
//   node native/mixdog-spawn/tests/fixtures/record-shell-jobs.mjs
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-shell-jobs-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const jobsDir = join(dataDir, 'shell-jobs');
mkdirSync(jobsDir);

const { shellJobsStatusFresh } = await import('../../../../src/runtime/shared/statusline/statusline-segments.mjs');

const HOST_PID = process.pid;
const BASE = 1_800_000_000_000;
let now = BASE;
Date.now = () => now;

const records = new Map();
const file = (id, suffix) => join(jobsDir, `${id}${suffix}`);
const write = (id) => writeFileSync(file(id, '.json'), JSON.stringify(records.get(id)));
const touch = (name) => writeFileSync(join(jobsDir, name), '');
const drop = (name) => rmSync(join(jobsDir, name), { force: true });

const owners = ['th', 'other', 'cap'];
const steps = [];
let seq = 0;

async function scan() {
  const value = await shellJobsStatusFresh({ clientHostPid: HOST_PID });
  const sessions = value.sessions ?? {};
  const view = {};
  for (const owner of owners) {
    const bucket = sessions[owner] ?? { jobs: [], finished: [] };
    view[owner] = {
      jobs: bucket.jobs.map((j) => ({ id: j.taskId, unconfirmed: j.terminationUnconfirmed === true })),
      finished: bucket.finished.map((j) => [j.taskId, j.status, j.exitCode, Date.parse(j.finishedAt)]),
    };
  }
  return {
    threads: view,
    host: {
      count: value.count,
      jobs: value.jobs.map((j) => j.taskId),
      orphaned: (value.orphaned ?? []).map((j) => j.taskId),
    },
  };
}

async function step(op) {
  now = op.at ?? now;
  const id = op.id;
  switch (op.op) {
    case 'start':
      records.set(id, {
        command: `cmd ${id}`,
        cwd: 'C:\\work',
        pid: process.pid,
        startedAt: op.startMs,
        ownerSessionId: op.owner,
        ...(op.fg ? { foreground: true } : {}),
      });
      write(id);
      touch(`${id}.owner-${HOST_PID}`);
      break;
    case 'promote':
      delete records.get(id).foreground;
      write(id);
      break;
    case 'finish':
    case 'finishUnconfirmed':
      Object.assign(records.get(id), {
        status: op.status,
        exitCode: op.exitCode,
        finishedAt: new Date(now).toISOString(),
        ...(op.op === 'finishUnconfirmed' ? { terminationUnconfirmed: true } : {}),
      });
      write(id);
      if (op.op === 'finish') touch(`${id}.done`);
      break;
    case 'confirm':
      delete records.get(id).terminationUnconfirmed;
      write(id);
      touch(`${id}.done`);
      break;
    case 'ownerClosed':
      for (const [rid, rec] of records) {
        if (rec.ownerSessionId === op.owner) {
          rec.ownerSessionClosed = true;
          write(rid);
        }
      }
      break;
    case 'release':
      for (const suffix of ['.json', '.done', `.owner-${HOST_PID}`]) drop(`${id}${suffix}`);
      records.delete(id);
      break;
    case 'clean':
      for (const [rid, rec] of [...records]) {
        if (rec.ownerSessionId === op.owner && readdirSync(jobsDir).includes(`${rid}.done`)) {
          for (const suffix of ['.json', '.done', `.owner-${HOST_PID}`]) drop(`${rid}${suffix}`);
          records.delete(rid);
        }
      }
      break;
    case 'advance':
      now += op.ms;
      break;
    default:
      throw new Error(op.op);
  }
  steps.push({ ...op, now, snapshot: await scan() });
}

const ids = [];
const startOp = async (owner, i, extra = {}) => {
  const startMs = BASE + 1000 + i * 10;
  const id = `job_${startMs}_${String(i).padStart(3, '0')}`;
  ids.push(id);
  await step({ op: 'start', id, owner, startMs, at: now + 1000, ...extra });
  return id;
};
const at = (ms = 1000) => now + ms;

// Twenty jobs of one thread, a few of another, a foreground command.
const th = [];
for (let i = 0; i < 20; i += 1) th.push(await startOp(i % 7 === 6 ? 'other' : 'th', i));
const fg = await startOp('th', 20, { fg: true });
await step({ op: 'promote', id: fg, at: at() });
// Two jobs that start in the same millisecond.
const tieA = `job_${BASE + 5000}_a`;
const tieB = `job_${BASE + 5000}_b`;
await step({ op: 'start', id: tieB, owner: 'th', startMs: BASE + 5000, at: at() });
await step({ op: 'start', id: tieA, owner: 'th', startMs: BASE + 5000, at: at() });

const outcomes = [
  ['completed', 0],
  ['failed', 2],
  ['failed', 124],
  ['cancelled', 137],
  ['failed', null],
  ['completed', 0],
];
const finishOrder = [th[3], th[0], th[5], th[1], th[9], th[2]];
for (let i = 0; i < finishOrder.length; i += 1) {
  await step({ op: 'finish', id: finishOrder[i], status: outcomes[i][0], exitCode: outcomes[i][1], at: at() });
}
// A stopped command whose processes are not confirmed gone stays listed, not finished.
await step({ op: 'finishUnconfirmed', id: th[4], status: 'cancelled', exitCode: 137, at: at() });
await step({ op: 'ownerClosed', owner: 'th', at: at() });
await step({ op: 'confirm', id: th[4], at: at() });
await step({ op: 'finishUnconfirmed', id: th[7], status: 'cancelled', exitCode: 137, at: at() });
await step({ op: 'release', id: th[7], at: at() });
await step({ op: 'finish', id: fg, status: 'completed', exitCode: 0, at: at() });
// Retention: 10, 29 and 31 minutes later.
await step({ op: 'advance', ms: 10 * 60_000 });
await step({ op: 'finish', id: th[8], status: 'completed', exitCode: 0, at: at() });
await step({ op: 'advance', ms: 19 * 60_000 });
await step({ op: 'advance', ms: 60_000 + 1 });
await step({ op: 'advance', ms: 2 * 60_000 });
await step({ op: 'clean', owner: 'th', at: at() });
await step({ op: 'release', id: th[10], at: at() });

// Caps: 65 more background jobs (the newest 60 records are listed), then 35 finished (the
// newest 30 are listed).
const cap = [];
for (let i = 100; i < 165; i += 1) cap.push(await startOp('cap', i));
for (let i = 0; i < 35; i += 1) {
  await step({ op: 'finish', id: cap[i], status: i % 2 ? 'failed' : 'completed', exitCode: i % 2, at: at(10) });
}

rmSync(dataDir, { recursive: true, force: true });
writeFileSync(join(here, 'shell-jobs.json'), `${JSON.stringify({ owners, retentionMs: 30 * 60_000, steps }, null, 1)}\n`);
console.log(`recorded ${steps.length} steps`);
