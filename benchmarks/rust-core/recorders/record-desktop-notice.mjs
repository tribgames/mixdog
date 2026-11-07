#!/usr/bin/env node
// The desktop notice host (src/runtime/shared/desktop-notice-host.mjs) and its one keychain raiser
// (lib/keychain-cjs.cjs `_noticeSecretStoreFailure`): the REAL modules, loaded from the tree under
// test. Records what a raise returns and what a registered sink receives for each step: the key
// dedupe ("raised once per key until clearDesktopNotice re-arms it"), the string coercion of
// `params`, the refusal of an empty key or code, and the keychain's notice for each failure kind.
// All user dirs are sandboxed.
//
//   node benchmarks/rust-core/recorders/record-desktop-notice.mjs [--tree <dir>]
//
// Output: native/core/fixtures/desktop-notice/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'desktop-notice');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-desktop-notice.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'desktop-notice-rec-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'desktop-notice-home-'));

const REGISTRY = Symbol.for('mixdog.desktopNoticeHost.v1');
let generation = 0;
/** A fresh registry and a fresh load of the host, with one sink collecting what is delivered. */
async function freshHost() {
  delete globalThis[REGISTRY];
  generation += 1;
  const host = await import(`${pathToFileURL(join(tree, 'src/runtime/shared/desktop-notice-host.mjs')).href}?fresh=${generation}`);
  const delivered = [];
  host.registerDesktopNoticeSink((notice, replay) => {
    delivered.push({ notice, replay });
    return true;
  });
  return { host, delivered };
}

const hostSteps = [];
{
  const { host, delivered } = await freshHost();
  const step = (op, args, run) => {
    const before = delivered.length;
    const returned = run();
    hostSteps.push({ op, args, returned: returned ?? null, delivered: delivered.slice(before).map((d) => d.notice) });
  };
  const raise = (...args) => step('raise', args, () => host.raiseDesktopNotice(...args));
  const clear = (key) => step('clear', [key], () => host.clearDesktopNotice(key));
  raise('secret-storage', 'secret-storage-failed');
  raise('secret-storage', 'secret-storage-failed');
  raise('conversation-save', 'conversation-save-failed');
  raise('', 'secret-storage-failed');
  raise('empty-code', '');
  raise(undefined, 'secret-storage-failed');
  raise('provider-sign-in:anthropic', 'provider-sign-in-expired', { name: 7, other: null });
  raise('provider-sign-in:anthropic', 'provider-sign-in-expired', { name: 'again' });
  clear('secret-storage');
  clear('never-raised');
  raise('secret-storage', 'secret-storage-failed');
  raise('secret-storage', 'secret-storage-failed');
}

// The keychain raiser, through the real registry.
const keychainSteps = [];
{
  const { host, delivered } = await freshHost();
  const path = join(tree, 'src/lib/keychain-cjs.cjs');
  const Module = createRequire(import.meta.url)('node:module');
  const module = new Module(path, null);
  module.filename = path;
  module.paths = Module._nodeModulePaths(dirname(path));
  module._compile(readFileSync(path, 'utf8') + '\nmodule.exports.__t = { _noteKeychainOk, _noteKeychainFailure };\n', path);
  const t = module.exports.__t;
  const failure = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  const run = (name, op) => {
    const before = delivered.length;
    op();
    keychainSteps.push({ step: name, delivered: delivered.slice(before).map((d) => d.notice) });
  };
  run('failure', () => t._noteKeychainFailure(failure('the keyring is locked', null)));
  run('second failure', () => t._noteKeychainFailure(failure('storage exploded', null)));
  run('no provider', () => t._noteKeychainFailure(failure('no keyring provider on this host', 'KEYRING_UNAVAILABLE')));
  run('unreachable', () => t._noteKeychainFailure(failure('gdbus gave an unparsable reply', 'KEYRING_UNREACHABLE')));
  run('ok', () => t._noteKeychainOk());
  run('failure after ok', () => t._noteKeychainFailure(failure('storage exploded', null)));
  run('cleared', () => host.clearDesktopNotice('secret-storage'));
  run('failure after clear', () => t._noteKeychainFailure(failure('storage exploded', null)));
}

writeJson(join(stage, 'golden.json'), { hostSteps, keychainSteps });
writeSetManifest(stage, { set: 'desktop-notice', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);