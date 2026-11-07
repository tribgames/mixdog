#!/usr/bin/env node
// What the daemon's log file holds for a `console.warn` (WP-AI-SVC): the REAL `createDaemonLog` of
// src/standalone/daemon-log.mjs with its redirect installed (`installRedirect`), and `console.warn`
// called with one string. The redirect writes `[console.warn] <text>` to daemon.log (bounded to 16 384
// characters, then bounded again as a log line, trailing white space trimmed), without the `[daemon]` tag.
// The Rust `DaemonLog::console_warn` must write the same lines.
//
//   node benchmarks/rust-core/recorders/record-console-redirect.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/console-redirect/golden.json.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

delete process.env.MIXDOG_DAEMON_ALLOW_STDERR;
const { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'console-redirect');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-console-redirect.mjs';
const { createDaemonLog } = await import(pathToFileURL(join(tree, 'src/standalone/daemon-log.mjs')).href);

const CASES = [
  { name: 'a_warning', parts: [['[config] applying the providers change failed: registry refused', 1]] },
  { name: 'trailing_white_space_is_trimmed', parts: [['a warning', 1], ['\n\n  ', 1]] },
  { name: 'an_empty_warning_still_has_its_tag', parts: [] },
  { name: 'unicode', parts: [['설정 적용 실패: ', 1], ['é', 3]] },
  { name: 'a_long_warning_is_bounded_twice', parts: [['w', 20000]] },
];
const build = (parts) => parts.map(([text, count]) => text.repeat(count)).join('');

const dir = mkdtempSync(join(tmpdir(), 'console-redirect-'));
const logPath = join(dir, 'daemon.log');
const sink = { write: () => true };
const consoleTarget = {};
const log = createDaemonLog({ logPath, stderr: { ...sink }, stdout: { ...sink }, consoleTarget });
log.enableFileLogging();
log.installRedirect();
for (const item of CASES) consoleTarget.warn(build(item.parts));
await log.flush();
const lines = readFileSync(logPath, 'utf8').split('\n').filter((line) => line !== '').map((line) => line.replace(/^\[[^\]]+\] /, ''));
if (lines.length !== CASES.length) throw new Error(`expected ${CASES.length} lines, got ${lines.length}`);
const cases = CASES.map((item, index) => ({ name: item.name, parts: item.parts, line: lines[index] }));
writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, { set: 'console-redirect', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);