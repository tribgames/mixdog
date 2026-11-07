#!/usr/bin/env node
// Golden twin of the daemon log writer (`src/standalone/daemon-log.mjs` `createDaemonLog`): the real writer driven
// against a real temp directory with a stepped clock, and what reached the file. Rust
// `mixdog_app_server_daemon::daemon_log::DaemonLog` must write the same bytes in every scenario.
//
//   node benchmarks/rust-core/recorders/record-daemon-log.mjs --tree <dir>
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const root = mkdtempSync(join(tmpdir(), 'record-daemon-log-'));
// Nothing under the user's directories may be read or written by the modules imported below.
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  const dir = join(root, `env-${name}`);
  mkdirSync(dir, { recursive: true });
  process.env[name] = dir;
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
delete process.env.MIXDOG_DAEMON_ALLOW_STDERR;

// `new Date()` steps one millisecond per call, in call order: the Rust clock does the same.
const BASE_MS = Date.UTC(2026, 10, 7, 12, 0, 0, 0);
const RealDate = Date;
let ticks = 0;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(BASE_MS + ticks++);
    else super(...args);
  }
};

const href = (rel) => new URL(`file:///${join(tree, rel).replaceAll('\\', '/')}`).href;
const { createDaemonLog } = await import(href('src/standalone/daemon-log.mjs'));
const debugModule = await import(href('src/lib/mixdog-debug.cjs'));
const { PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } = debugModule.default ?? debugModule;

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const build = (parts) => parts.map(([text, count]) => text.repeat(count)).join('');
/** The pattern a pre-existing log file holds: not text, so a tail copied at the wrong offset shows. */
const patterned = (size) => Buffer.from(Array.from({ length: size }, (_, i) => i % 251));

/**
 * ops: `log` (parts), `raw` (chunk through the redirected stderr), `enable`, `flush`, `gate` (hold the first
 * append until `release`), `release`. `prefile`: size of a patterned file, or `fill` bytes of one letter.
 * `fault`: `{ append: n, writes: bool }` makes the nth append throw, after landing its bytes when `writes`.
 */
const scenarios = {
  handoff: { ops: [{ op: 'log', parts: [['before ready', 1]] }, { op: 'enable' }, { op: 'log', parts: [['after ready', 1]] }, { op: 'flush' }] },
  truncation: {
    ops: [
      { op: 'enable' },
      { op: 'log', parts: [['x', 16384 - 9]] },
      { op: 'log', parts: [['y', 16385 - 9]] },
      { op: 'log', parts: [['a', 16384 - 9 - 1], ['\u{1F600}', 1], ['tail', 1]] },
      { op: 'log', parts: [['z', 20000]] },
      { op: 'log', parts: [['multi \u00e9\u4e2d ', 3]] },
      { op: 'flush' },
    ],
  },
  backpressure: {
    ops: [
      { op: 'enable' },
      { op: 'gate' },
      { op: 'log', parts: [['held write', 1]] },
      { op: 'held' },
      ...Array.from({ length: 100 }, () => ({ op: 'log', parts: [['x', 16384]] })),
      { op: 'release' },
      { op: 'flush' },
    ],
  },
  raw: {
    ops: [{ op: 'enable' }, { op: 'raw', chunk: 'raw stderr\n' }, { op: 'raw', chunk: '   \n' }, { op: 'raw', chunk: 'two\n\n  ' }, { op: 'raw', chunk: '' }, { op: 'flush' }],
  },
  failedAppendLosesOnlyItsBatch: {
    fault: { append: 1, writes: false },
    ops: [{ op: 'enable' }, { op: 'log', parts: [['first', 1]] }, { op: 'flush' }, { op: 'log', parts: [['second', 1]] }, { op: 'flush' }],
  },
  rotation: { prefile: { patterned: PLUGIN_LOG_MAX_BYTES }, ops: [{ op: 'enable' }, { op: 'log', parts: [['after rotation', 1]] }, { op: 'flush' }] },
  rotationSmallFile: { prefile: { patterned: 1000 }, ops: [{ op: 'enable' }, { op: 'log', parts: [['small', 1]] }, { op: 'flush' }] },
  // A line is 38 bytes here ("[<24>] [daemon] x\n"): one byte under the cap leaves exactly room, one over rotates.
  noRotationAtTheCap: { prefile: { patterned: PLUGIN_LOG_MAX_BYTES - 38 }, ops: [{ op: 'enable' }, { op: 'log', parts: [['x', 1]] }, { op: 'flush' }] },
  rotationOneOverTheCap: { prefile: { patterned: PLUGIN_LOG_MAX_BYTES - 37 }, ops: [{ op: 'enable' }, { op: 'log', parts: [['x', 1]] }, { op: 'flush' }] },
  partialAppendFailureInvalidatesTheCount: {
    prefile: { fill: 'x', size: PLUGIN_LOG_MAX_BYTES - 16384 },
    fault: { append: 1, writes: true },
    ops: [{ op: 'enable' }, { op: 'log', parts: [['a', 16000]] }, { op: 'flush' }, { op: 'log', parts: [['b', 1000]] }, { op: 'flush' }],
  },
};

// The writer's flush timer is unref'd; something must keep the loop alive while a gated write waits.
const keepAlive = setInterval(() => {}, 1000);
const out = {};
for (const [name, scenario] of Object.entries(scenarios)) {
  ticks = 0;
  const dir = join(root, name);
  const logPath = join(dir, 'nested', 'daemon.log');
  mkdirSync(dir, { recursive: true });
  if (scenario.prefile) {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    const { patterned: size, fill } = scenario.prefile;
    writeFileSync(logPath, size !== undefined ? patterned(size) : Buffer.alloc(scenario.prefile.size, fill));
  }
  const appends = [];
  let enteredGate;
  const entered = new Promise((resolve) => { enteredGate = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let gated = false;
  const fileSystem = {
    ...fsPromises,
    async appendFile(path, batch, encoding) {
      const n = appends.length + 1;
      const text = String(batch);
      const lines = text.split('\n').length - 1;
      appends.push({ bytes: Buffer.byteLength(text), lines, notice: /^\[[^\]]+\] \[daemon\] dropped \d+ log line\(s\) under backpressure\n/.test(text) ? text.split('\n')[0] : null });
      if (gated && n === 1) {
        enteredGate();
        await released;
      }
      if (scenario.fault?.append === n) {
        if (scenario.fault.writes) await fsPromises.appendFile(path, batch, encoding);
        throw new Error('fixture append fault');
      }
      return fsPromises.appendFile(path, batch, encoding);
    },
  };
  const stderrRows = [];
  const stderr = { write: (chunk) => { stderrRows.push(String(chunk)); return true; } };
  const stdout = { write: () => true };
  const logger = createDaemonLog({ logPath, fileSystem, stderr, stdout, consoleTarget: {} });
  for (const op of scenario.ops) {
    if (op.op === 'log') logger.log(build(op.parts));
    else if (op.op === 'enable') {
      logger.enableFileLogging();
      logger.installRedirect();
    } else if (op.op === 'raw') stderr.write(op.chunk);
    else if (op.op === 'gate') gated = true;
    else if (op.op === 'held') await entered;
    else if (op.op === 'release') release();
    else if (op.op === 'flush') await logger.flush();
  }
  await logger.flush();
  const bytes = readFileSync(logPath);
  out[name] = {
    ...scenario,
    stderrRows,
    appends,
    fileBytes: bytes.length,
    fileSha256: sha(bytes),
    // The files that stay readable as text are kept whole; the large ones are pinned by length and digest.
    fileText: bytes.length <= 70_000 ? bytes.toString('utf8') : null,
    firstByte: bytes[0] ?? null,
  };
}
clearInterval(keepAlive);
rmSync(root, { recursive: true, force: true });
globalThis.Date = RealDate;

writeJson(join(FIXTURES_ROOT, 'daemon-log', 'golden.json'), {
  baseMs: BASE_MS,
  limits: { maxBytes: PLUGIN_LOG_MAX_BYTES, keepBytes: PLUGIN_LOG_KEEP_BYTES, lineMaxChars: 16_384, queueMaxBytes: 512 * 1024 },
  scenarios: out,
});
writeSetManifest(join(FIXTURES_ROOT, 'daemon-log'), {
  set: 'daemon-log',
  recorder: 'benchmarks/rust-core/recorders/record-daemon-log.mjs',
  command: 'node benchmarks/rust-core/recorders/record-daemon-log.mjs --tree <tree>',
  identityTree: tree,
});
console.log(`recorded ${Object.keys(out).length} daemon log scenarios`);
process.exit(0);
