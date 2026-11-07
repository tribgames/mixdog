#!/usr/bin/env node
// What Node reports when dotnet-format's report-directory cleanup fails: the REAL engine suite
// (src/runtime/tidy/run-engines.mjs) over the REAL dotnet-format runner (runners/dotnet-format.mjs),
// the engine command a stub (node + a script that writes an empty report), and `fs.rmSync` of the
// report directory made to throw a REAL Node error (`fs.rmdirSync` of that non-empty directory:
// ENOTEMPTY ... rmdir '<path>'). Recorded in an isolated temp tree: the engine result of a check whose
// runner throws out of its `finally`, the error's code/syscall/message, and the same check without a
// failure. Paths are replaced by <report>.
//   node benchmarks/rust-core/recorders/record-dotnet-format-cleanup.mjs [--tree <dir>]
// Output: native/core/fixtures/dotnet-format-cleanup/golden.json.
process.env.TZ = 'UTC';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'dotnet-format-cleanup');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-dotnet-format-cleanup.mjs';

const root = mkdtempSync(join(tmpdir(), 'dotnet-cleanup-rec-'));
const cwd = join(root, 'project');
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, 'a.cs'), 'class A {}\n');
const stub = join(root, 'stub-dotnet.mjs');
writeFileSync(stub, `import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
writeFileSync(argv[argv.indexOf('--report') + 1], '[]');
`);

let failure = null;
const realRmSync = fs.rmSync;
fs.rmSync = (path, options) => {
  if (failure && String(path).includes('mixdog-dotnet-format-')) {
    failure = { path: String(path) };
    return fs.rmdirSync(path);
  }
  return realRmSync(path, options);
};
syncBuiltinESMExports();

const { runEngineSuite } = await import(pathToFileURL(join(tree, 'src', 'runtime', 'tidy', 'run-engines.mjs')).href);
const engine = { id: 'dotnet-format', source: 'recorded', command: process.execPath, args: [stub], languages: ['csharp'] };
const hide = (text, path) => String(text).replaceAll(path, '<report>');

failure = {};
let thrownError = null;
const probe = fs.rmdirSync;
fs.rmdirSync = (path, ...rest) => {
  try {
    return probe(path, ...rest);
  } catch (error) {
    thrownError = error;
    throw error;
  }
};
syncBuiltinESMExports();
const [broken] = await runEngineSuite({ engines: [engine], files: ['a.cs'], cwd, mode: 'check' });
const reportPath = failure.path;
failure = null;
const [fine] = await runEngineSuite({ engines: [engine], files: ['a.cs'], cwd, mode: 'check' });
fs.rmdirSync = probe;
fs.rmSync = realRmSync;
syncBuiltinESMExports();

const golden = {
  failedCleanup: {
    result: { ...broken, error: hide(broken.error, reportPath) },
    error: { code: thrownError.code, syscall: thrownError.syscall, message: hide(thrownError.message, reportPath) },
  },
  withoutFailure: { result: fine },
};
fs.rmSync(root, { recursive: true, force: true });
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'dotnet-format-cleanup', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);