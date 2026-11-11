// The job-views watcher reads a session's record through a header scan of its
// log, and the first scan of each log in a process read all of it: at 250 MB a
// log, with every agent session watched, each start of the daemon read every
// log whole. The scan now leaves its place in a checkpoint and the next
// process goes on from it. Observed across two real processes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  encodeAppend,
  encodeCompacted,
  encodePatch,
  encodeSessionRecord,
} from '../../../../runtime/agent/orchestrator/session/store/session-log-format.mjs';

const runNode = promisify(execFile);
const SESSION_ID = 'sess_daemon_1794000000000_0123456789abcdef0123456789abcdef';

const watchScript = `
  const [dataDir, sessionId] = process.argv.slice(1);
  process.env.MIXDOG_DATA_DIR = dataDir;
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  let bytes = 0;
  const readSync = fs.default.readSync;
  fs.default.readSync = (...args) => {
    const got = readSync(...args);
    bytes += got;
    return got;
  };
  syncBuiltinESMExports();
  const FileHandle = Object.getPrototypeOf(await fs.promises.open(dataDir));
  const handleRead = FileHandle.read;
  FileHandle.read = async function (...args) {
    const got = await handleRead.apply(this, args);
    bytes += got.bytesRead;
    return got;
  };
  const { acquireSessionRecords } = await import('./src/session-runtime/services/agent-tool/job-views/session-record.mjs');
  const records = acquireSessionRecords({ loadSessionStatus() {}, getSession: () => null });
  // The record is read in the background and announced by its change event.
  let view = records.session(sessionId);
  if (!view?.messageCount) {
    view = await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('the watcher announced no record of the session within 20 s')),
        20000
      );
      const stop = records.onChange(() => {
        const read = records.session(sessionId);
        if (!read?.messageCount) return;
        clearTimeout(deadline);
        stop();
        resolve(read);
      });
    });
  }
  records.release();
  process.stdout.write(JSON.stringify({ bytes, view }));
  process.exit(0);
`;

test('a watcher in a new process reads a log from where the last process stopped', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-job-views-checkpoint-'));
  try {
    const sessions = join(dataDir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const logPath = join(sessions, `${SESSION_ID}.log.jsonl`);
    const message = JSON.stringify({ role: 'user', content: 'z'.repeat(512 * 1024) });
    let text =
      encodeSessionRecord({ logId: 'L1', id: SESSION_ID, legacy: null, header: { id: SESSION_ID, title: 'first' } }) +
      encodeCompacted(1, [message]);
    for (let i = 0; i < 40; i += 1) text += encodeAppend(2 + i, 2 + i, [message]);
    writeFileSync(logPath, text);
    const size = statSync(logPath).size;
    assert.ok(size > 20 * 1024 * 1024, `a ${size}-byte log`);

    const watch = async () => {
      const { stdout } = await runNode(process.execPath, ['--input-type=module', '-e', watchScript, dataDir, SESSION_ID], {
        cwd: process.cwd(),
        maxBuffer: 16 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    };
    const first = await watch();
    assert.equal(first.view.title, 'first');
    assert.equal(first.view.messageCount, 41);
    assert.ok(first.bytes >= size, `the first process read ${first.bytes} of ${size} bytes`);

    appendFileSync(logPath, encodePatch(42, [['title', '"second"']], []));
    const second = await watch();
    assert.equal(second.view.title, 'second');
    assert.equal(second.view.messageCount, 41);
    assert.ok(second.bytes < size / 10, `the next process read ${second.bytes} of ${size} bytes`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
