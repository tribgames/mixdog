#!/usr/bin/env node
// The keychain health Node tracks (lib/keychain-cjs.cjs `_keychainStatus`, `keychainStatus()`):
// a status that starts `unknown`, becomes `ok` when a keychain call succeeds and takes a state
// from the message of a failure (locked / timed out -> locked, not installed -> missing, the
// unreachable code -> unreachable, anything else -> error), with `fallback` only on Linux and a
// desktop notice for every failure that is not a "no provider / unreachable" report. The module is
// loaded from its own source with a footer exposing the internal notes, so the REAL functions
// answer. This host is Windows: the recorded platform is `win32`; the Linux and macOS recordings
// belong to those build hosts (same recorder, `platform` is part of the output).
//
//   node benchmarks/rust-core/recorders/record-keychain-status.mjs [--tree <dir>]
//
// Output: native/core/fixtures/keychain-status-<platform>/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const platform = process.platform;
const finalDir = join(FIXTURES_ROOT, `keychain-status-${platform}`);
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-keychain-status.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'keychain-status-rec-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'keychain-status-home-'));

const path = join(tree, 'src/lib/keychain-cjs.cjs');
const Module = createRequire(import.meta.url)('node:module');
const notices = [];
globalThis[Symbol.for('mixdog.desktopNoticeHost.v1')] = { raise: (...args) => notices.push(args) };
function load() {
  const module = new Module(path, null);
  module.filename = path;
  module.paths = Module._nodeModulePaths(dirname(path));
  const footer = '\nmodule.exports.__t = { _noteKeychainOk, _noteKeychainFailure, _noteSyncOutcome, keychainStatus };\n';
  module._compile(readFileSync(path, 'utf8') + footer, path);
  return module.exports.__t;
}

const failure = (message, code) => Object.assign(new Error(message), code ? { code } : {});
const STEPS = [
  ['ok', 'a call succeeded'],
  ['fail', 'the keyring is locked', null],
  ['fail', 'secret store operation timed out after 15000ms', null],
  ['fail', 'secret-tool is not installed', null],
  ['fail', 'storage exploded', null],
  ['fail', 'LOCKED outranks nothing: Locked', null],
  ['fail', 'no keyring provider on this host', 'KEYRING_UNAVAILABLE'],
  ['fail', 'gdbus gave an unparsable reply', 'KEYRING_UNREACHABLE'],
  ['fail', 'the keyring is locked and unreachable', 'KEYRING_UNREACHABLE'],
  ['ok'],
  ['syncFail', 'the keyring is locked', null],
  ['syncOk'],
  ['fail', 'not installed but also timed out', null],
];
const t = load();
const steps = [{ step: 'fresh', status: t.keychainStatus(), notices: notices.length }];
for (const [op, message, code] of STEPS) {
  const before = notices.length;
  if (op === 'ok') t._noteKeychainOk();
  else if (op === 'fail') t._noteKeychainFailure(failure(message, code));
  else if (op === 'syncFail') t._noteSyncOutcome(failure(message, code));
  else t._noteSyncOutcome(null);
  steps.push({ step: op, message: message ?? null, code: code ?? null, status: t.keychainStatus(), noticed: notices.length - before });
}
writeJson(join(stage, 'golden.json'), { platform, steps });
writeSetManifest(stage, { set: `keychain-status-${platform}`, recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);
