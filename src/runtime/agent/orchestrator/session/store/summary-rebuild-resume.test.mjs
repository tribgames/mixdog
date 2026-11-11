// The listing's rebuild worker reads every log of the store to rebuild an
// index that is gone, from nothing: it held each transcript whole and read
// each log whole, every time it was started (a 205 MB log took it past its
// heap and the daemon with it, 2026-11-10, and the next start tried again).
// It now reads a log as the facts its summary is made of, block by block, and
// the next worker goes on from where the last one stopped. Observed across
// two real processes; the rows are the rows a whole read gives.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { encodeAppend, encodeCompacted, encodePatch, encodeSessionRecord } from './session-log-format.mjs';

const runNode = promisify(execFile);
const SESSION_ID = 'sess_daemon_1794000000000_00112233445566778899aabbccddeeff';
const S = './src/runtime/agent/orchestrator/session/store/';

const scanScript = `
  const [dataDir, resumable] = process.argv.slice(1);
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
  const readFile = fs.promises.readFile;
  fs.promises.readFile = async (...args) => {
    const got = await readFile(...args);
    bytes += got.length;
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
  const { _scanStoredSessionSummaryRowsAsync } = await import('${S}summary-cache.mjs');
  const { rows } = await _scanStoredSessionSummaryRowsAsync({ resumable: resumable === 'yes' });
  process.stdout.write(JSON.stringify({ bytes, rows }));
`;

test('a rebuild worker goes on from where the last one stopped and builds the rows a whole read builds', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-rebuild-resume-'));
  try {
    const sessions = join(dataDir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const logPath = join(sessions, `${SESSION_ID}.log.jsonl`);
    const user = (text) => JSON.stringify({ role: 'user', content: text });
    const filler = 'w'.repeat(512 * 1024);
    let text =
      encodeSessionRecord({
        logId: 'L1',
        id: SESSION_ID,
        legacy: null,
        header: { id: SESSION_ID, title: 'first', updatedAt: 1000, createdAt: 900 },
      }) + encodeCompacted(1, [user('the first prompt')]);
    for (let i = 0; i < 70; i += 1) text += encodeAppend(2 + i, 2 + i, [user(`${filler} ${i}`)]);
    writeFileSync(logPath, text);
    const size = statSync(logPath).size;
    assert.ok(size > 32 * 1024 * 1024, `a ${size}-byte log`);

    const scan = async (resumable) => {
      const { stdout } = await runNode(process.execPath, ['--input-type=module', '-e', scanScript, dataDir, resumable], {
        cwd: process.cwd(),
        maxBuffer: 64 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    };
    const first = await scan('yes');
    assert.ok(first.bytes >= size, `the first worker read ${first.bytes} of ${size} bytes`);

    appendFileSync(logPath, encodePatch(72, [['title', '"second"'], ['updatedAt', '2000']], []) + encodeAppend(73, 72, [user('the last prompt')]));
    const second = await scan('yes');
    assert.ok(second.bytes < size / 10, `the next worker read ${second.bytes} of ${size} bytes`);
    const whole = await scan('no');
    assert.ok(whole.bytes >= size, 'without the option the log is read whole');
    assert.equal(second.rows.length, 1);
    assert.equal(second.rows[0].title, 'second');
    assert.equal(second.rows[0].messageCount, 72);
    assert.equal(second.rows[0].preview, 'the first prompt');
    assert.deepEqual(second.rows, whole.rows);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
