// The header-probe worker retires after HEADER_WORKER_IDLE_EXIT_MS and starts
// again with no place of its own in any log, and its first probe of each log
// read all of it: after 30 s idle every probe of every session log read the
// logs whole. A worker now leaves its place in a checkpoint and the next one
// goes on from it. Observed through two real worker threads, the bytes each
// reads counted from inside it.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createWorkerRequestClient } from '../../../shared/worker-requests.mjs';
import {
  encodeAppend,
  encodeCompacted,
  encodePatch,
  encodeSessionRecord,
} from './store/session-log-format.mjs';

const SESSION_ID = 'sess_daemon_1794000000000_fedcba9876543210fedcba9876543210';
const FIELDS = ['title', 'status'];

// Runs first in the worker: counts every byte it reads and leaves the count
// of each answer in a file, as the answer goes out.
const COUNTER = `
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  import { parentPort } from 'node:worker_threads';
  let bytes = 0;
  const readSync = fs.readSync;
  fs.readSync = (...args) => {
    const got = readSync(...args);
    bytes += got;
    return got;
  };
  syncBuiltinESMExports();
  const post = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = (message, ...rest) => {
    fs.writeFileSync(process.env.PROBE_BYTES_FILE, String(bytes));
    bytes = 0;
    return post(message, ...rest);
  };
`;

test('a restarted header worker goes on from the place the last one left in a log', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-header-worker-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const sessions = join(dataDir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const logPath = join(sessions, `${SESSION_ID}.log.jsonl`);
    const jsonPath = join(sessions, `${SESSION_ID}.json`);
    const message = JSON.stringify({ role: 'user', content: 'q'.repeat(512 * 1024) });
    let text =
      encodeSessionRecord({ logId: 'L1', id: SESSION_ID, legacy: null, header: { id: SESSION_ID, title: 'first', status: 'idle' } }) +
      encodeCompacted(1, [message]);
    for (let i = 0; i < 40; i += 1) text += encodeAppend(2 + i, 2 + i, [message]);
    writeFileSync(logPath, text);
    const size = statSync(logPath).size;
    assert.ok(size > 20 * 1024 * 1024, `a ${size}-byte log`);

    const counter = join(dataDir, 'counter.mjs');
    const bytesFile = join(dataDir, 'bytes.txt');
    writeFileSync(counter, COUNTER);
    // One worker thread's life: a probe, then its idle retirement.
    const probe = async () => {
      const request = createWorkerRequestClient(new URL('./store-agent-worker-header-worker.mjs', import.meta.url), {
        idleExitMs: 50,
        execArgv: ['--import', pathToFileURL(counter).href],
        env: { ...process.env, PROBE_BYTES_FILE: bytesFile },
      });
      // The worker leaves its count before it answers, so the answer is the event to wait on;
      // it retires on its own, and the next probe is another client: another thread.
      const [answer] = await request({ fields: FIELDS, entries: [[jsonPath, null]] }, { timeoutMs: 30_000 });
      // (a request unanswered after 30 s rejects with ETIMEDOUT: 'worker request timed out')
      return { answer, bytes: Number(readFileSync(bytesFile, 'utf8')) };
    };
    const first = await probe();
    assert.equal(first.answer.header.title, 'first');
    assert.ok(first.bytes >= size, `the first worker read ${first.bytes} of ${size} bytes`);

    appendFileSync(logPath, encodePatch(42, [['title', '"second"'], ['status', '"working"']], []));
    const second = await probe();
    assert.deepEqual(second.answer.header, { title: 'second', status: 'working' });
    assert.ok(second.bytes < size / 10, `the restarted worker read ${second.bytes} of ${size} bytes`);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
