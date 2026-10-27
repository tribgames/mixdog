/**
 * Test support, never shipped (package.json `files` drops `*.test-hook.mjs`):
 * fault injection for the workspace admission ledger. The admission thread
 * loads this fixed file when MIXDOG_ADMISSION_TEST_FAULT_HOOK=1
 * (activity-ledger-worker.mjs); a test may also import it into its own
 * thread. The plan is read at every intercepted call from
 * MIXDOG_ADMISSION_TEST_FAULTS, which the admission thread shares with the
 * process (SHARE_ENV), so a test changes it synchronously between requests:
 * JSON `{ nonce, rules }` (a new nonce restarts every rule's count). A rule:
 *
 *   op      'rename' (matched on its target) or 'unlink'
 *   file    basename of the path
 *   when    'before' (default) or 'after' the call
 *   api     'sync', 'async' (fs/promises) or 'any' (default)
 *   thread  'main', 'worker' or 'any' (default)
 *   hits    [bool, ...] per matching call in order; absent: every call
 *   action  'fail' (`code`, default EIO), 'delay' (`ms`), 'snapshot' (appends
 *           the bytes of `files` to the JSON list in env `report`), 'kill'
 *           (the whole process, SIGKILL: no exit handler runs) or
 *           'exit-thread' (only the calling thread stops).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { sleep, sleepSync } from '../sleep.mjs';

const PLAN = 'MIXDOG_ADMISSION_TEST_FAULTS';
const thread = isMainThread ? 'main' : 'worker';
let planText = '';
let rules = [];

function currentRules() {
  const text = process.env[PLAN] || '';
  if (text !== planText) {
    planText = text;
    rules = text ? JSON.parse(text).rules.map((rule) => ({ ...rule, seen: 0 })) : [];
  }
  return rules;
}

function firing(op, path, when, api) {
  const name = basename(String(path));
  return currentRules().filter((rule) => {
    if (rule.op !== op || rule.file !== name || (rule.when ?? 'before') !== when) return false;
    if ((rule.api ?? 'any') !== 'any' && rule.api !== api) return false;
    if ((rule.thread ?? 'any') !== 'any' && rule.thread !== thread) return false;
    const index = rule.seen++;
    return rule.hits ? rule.hits[index] === true : true;
  });
}

const readOrNull = (path) => {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** Runs the rules' actions; returns the total delay they ask for. */
function act(firingRules, op, path, when) {
  let delayMs = 0;
  for (const rule of firingRules) {
    if (rule.action === 'fail') {
      throw Object.assign(new Error(`injected ${op} failure`), { code: rule.code ?? 'EIO' });
    }
    if (rule.action === 'delay') delayMs += rule.ms;
    if (rule.action === 'snapshot') {
      const list = JSON.parse(process.env[rule.report] || '[]');
      list.push({ op, file: basename(String(path)), when, copies: rule.files.map(readOrNull) });
      process.env[rule.report] = JSON.stringify(list);
    }
    if (rule.action === 'kill') {
      fs.writeSync(2, `[admission-faults] killed ${when} ${op} ${basename(String(path))}\n`);
      process.kill(process.pid, 'SIGKILL');
      sleepSync(60_000);
    }
    if (rule.action === 'exit-thread') process.exit(1);
  }
  return delayMs;
}

const original = { renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, rename: fsp.rename };

fs.renameSync = function renameSync(from, to, ...rest) {
  const before = act(firing('rename', to, 'before', 'sync'), 'rename', to, 'before');
  if (before) sleepSync(before);
  const result = original.renameSync.call(this, from, to, ...rest);
  const after = act(firing('rename', to, 'after', 'sync'), 'rename', to, 'after');
  if (after) sleepSync(after);
  return result;
};

fs.unlinkSync = function unlinkSync(path, ...rest) {
  const before = act(firing('unlink', path, 'before', 'sync'), 'unlink', path, 'before');
  if (before) sleepSync(before);
  const result = original.unlinkSync.call(this, path, ...rest);
  const after = act(firing('unlink', path, 'after', 'sync'), 'unlink', path, 'after');
  if (after) sleepSync(after);
  return result;
};

fsp.rename = async function rename(from, to, ...rest) {
  const before = act(firing('rename', to, 'before', 'async'), 'rename', to, 'before');
  if (before) await sleep(before);
  const result = await original.rename.call(this, from, to, ...rest);
  const after = act(firing('rename', to, 'after', 'async'), 'rename', to, 'after');
  if (after) await sleep(after);
  return result;
};

syncBuiltinESMExports();

let nonce = 0;

/** Sets the plan every thread of this process follows from its next intercepted call on; none clears it. */
export function setAdmissionFaults(...planned) {
  if (planned.length) process.env[PLAN] = JSON.stringify({ nonce: `${process.pid}-${++nonce}`, rules: planned });
  else delete process.env[PLAN];
}
