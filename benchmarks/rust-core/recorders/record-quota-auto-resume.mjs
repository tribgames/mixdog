#!/usr/bin/env node
// Golden of the global quota auto-resume switch (`native/core/fixtures/quota-auto-resume/golden.json`):
// what Node's `quotaAutoResumeEnabled()` (runtime/shared/quota-resume-store.mjs, over the real
// `readSection` of runtime/shared/config.mjs) answers for each `mixdog-config.json` the case
// writes into the data dir, and the file `setQuotaAutoResumeEnabled(next)` leaves behind.
//
//   node <repo>/benchmarks/rust-core/recorders/record-quota-auto-resume.mjs --tree <tree>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'quota-auto-resume-'));
// Every user directory the product reads is a fresh temp directory before any Mixdog module loads.
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  mkdirSync(join(sandbox, key));
  process.env[key] = join(sandbox, key);
}
delete process.env.MIXDOG_OWNER_SESSION_ID;
const at = (p) => import(pathToFileURL(join(repo, p)).href);

const config = await at('src/runtime/shared/config.mjs');
const store = await at('src/runtime/shared/quota-resume-store.mjs');
const file = join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json');
const install = (doc) => {
  if (doc === undefined) rmSync(file, { force: true });
  else writeFileSync(file, JSON.stringify(doc));
  config.invalidateConfigReadCache();
};
const onDisk = () => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// `config` undefined: no file at all.
const reads = [
  { name: 'no-file', config: undefined },
  { name: 'empty', config: {} },
  { name: 'off', config: { quotaResume: { autoResume: false } } },
  { name: 'on', config: { quotaResume: { autoResume: true } } },
  { name: 'section-without-key', config: { quotaResume: { other: 1 } } },
  { name: 'string-false', config: { quotaResume: { autoResume: 'false' } } },
  { name: 'zero', config: { quotaResume: { autoResume: 0 } } },
  { name: 'null', config: { quotaResume: { autoResume: null } } },
  { name: 'section-null', config: { quotaResume: null } },
  { name: 'section-false', config: { quotaResume: false } },
  { name: 'section-array', config: { quotaResume: [] } },
  { name: 'top-level-quotaAutoResume-false', config: { quotaAutoResume: false } },
  { name: 'agent-quotaAutoResume-false', config: { agent: { quotaAutoResume: false } } },
  { name: 'agent-quotaResume-off', config: { agent: { quotaResume: { autoResume: false } } } },
].map(({ name, config: doc }) => {
  install(doc);
  return { name, config: doc ?? null, enabled: store.quotaAutoResumeEnabled() };
});

// What the setter writes: from an empty file, off then on; the file and the read after each.
install({ quotaResume: { other: 1 } });
const writes = [false, true].map((next) => {
  const answered = store.setQuotaAutoResumeEnabled(next);
  config.invalidateConfigReadCache();
  return { next, answered: answered ?? null, file: onDisk(), enabled: store.quotaAutoResumeEnabled() };
});

rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const set = join(FIXTURES_ROOT, 'quota-auto-resume');
writeJson(join(set, 'golden.json'), { reads, writes });
writeSetManifest(set, {
  set: 'quota-auto-resume',
  recorder: 'benchmarks/rust-core/recorders/record-quota-auto-resume.mjs',
  command: 'node <repo>/benchmarks/rust-core/recorders/record-quota-auto-resume.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${reads.length} reads, ${writes.length} writes`);
process.exit(0);
