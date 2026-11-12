#!/usr/bin/env node
// What a settings save writes, on real Node: `createConfigPatch(before, after)` (orchestrator/config.mjs), the difference of the
// two stored forms a writer holds (the config it started from and the config it wants), over the configs the Node tests of the
// settings writers hand it (session-runtime/config-concurrency.test.mjs): profile edits of two writers, compaction and auto-clear
// switched by a peer, a skills list, a cleared nested shell setting, aliases that name the same setting (`thresholdMs` and `idleMs`,
// `compaction.enabled` and `auto`), an explicit provider OFF, and a keychain overlay (`apiKey`) that is never an edit.
// Per case: the two configs (whole) and the patch (whole, in Node's order).
//
// The store is a fresh data directory whose config file is already separated (`defaultsVersion: 2`), so the patch is in the stored domain.
//
//   node benchmarks/rust-core/recorders/record-config-create-patch.mjs --tree <exact export of b6f10295a with node_modules>
// Output: native/core/fixtures/config-create-patch/golden.json
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-config-create-patch.mjs';
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);

const sandbox = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-config-create-patch-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[name] = join(sandbox, name.toLowerCase());
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(sandbox, 'backups');
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json'), JSON.stringify({ defaultsVersion: 2, agent: {} }));
const { createConfigPatch } = await importFrom(tree, 'src/runtime/agent/orchestrator/config.mjs');

const cases = [
  { name: 'aliases of one setting and a changed keychain overlay are no edit', before: { autoClear: { thresholdMs: 90000 }, compaction: { enabled: false }, providers: { openai: { enabled: true, apiKey: 'old' } } }, after: { autoClear: { idleMs: 90000 }, compaction: { auto: false }, providers: { openai: { enabled: true, apiKey: 'new' } } } },
  { name: 'a changed idle window is an edit whatever its alias', before: { autoClear: { thresholdMs: 90000 } }, after: { autoClear: { idleMs: 120000 } } },
  { name: 'an explicit provider OFF', before: { profile: { title: 'T', language: 'ko' }, providers: { openai: { enabled: true, apiKey: 'k' } } }, after: { profile: { title: 'T', language: 'ko' }, providers: { openai: { enabled: false, apiKey: 'k' } } } },
  { name: 'a save after the secrets loaded never writes the overlay', before: { providers: { openai: { enabled: false } } }, after: { providers: { openai: { enabled: false, apiKey: 'loaded-from-keychain' } }, profile: { title: 'After secrets load' } } },
  { name: 'a profile edit of one writer', before: { profile: { title: 'Initial', language: 'ko' } }, after: { profile: { title: 'Initial', language: 'en' } } },
  { name: 'a profile edit of the other writer', before: { profile: { title: 'Initial', language: 'ko' } }, after: { profile: { title: 'Updated by B', language: 'ko' } } },
  { name: 'compaction and auto-clear switched off', before: { compaction: { auto: true }, autoClear: { enabled: true } }, after: { compaction: { auto: false }, autoClear: { enabled: false } } },
  { name: 'a skills list', before: { skills: { disabled: [] } }, after: { skills: { disabled: ['browser-use'] } } },
  { name: 'a shell setting added', before: {}, after: { shell: { command: 'pwsh', args: ['-NoProfile'] } } },
  { name: 'a nested shell setting cleared', before: { shell: { command: 'pwsh', args: ['-NoProfile'] } }, after: { shell: { args: [] } } },
  { name: 'nothing changed', before: { profile: { title: 'Same' }, shell: { command: 'pwsh' } }, after: { profile: { title: 'Same' }, shell: { command: 'pwsh' } } },
];
const out = cases.map((c) => ({ ...c, patch: createConfigPatch(structuredClone(c.before), structuredClone(c.after)) }));

const finalOut = join(FIXTURES_ROOT, 'config-create-patch');
const stage = stageSet(finalOut);
writeJson(join(stage, 'golden.json'), { note: 'createConfigPatch of real Node over the configs the settings-writer tests hand it', cases: out });
writeSetManifest(stage, {
  set: 'config-create-patch',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    cases: out.length,
    syntheticInputs: [
      'the before and after configs: the profile, compaction, auto-clear, skills, shell and provider settings the Node settings-writer tests use',
      'the data directory: empty but for a config file already separated (defaultsVersion 2)',
    ],
    keptWhole: 'per case: both configs and the patch (every change, path and value or removal, in Node\'s order)',
    exclusions: {
      'order of the changes of one patch': 'the golden\'s objects are written with sorted keys, so a replay reads each config\'s keys in another order than Node did and the order of independent edits follows it; the changes are compared as a list sorted by path (each edit is unique by path)',
    },
  },
});
commitStage(stage, finalOut);
rmSync(sandbox, { recursive: true, force: true });
console.log(`cases=${out.length}`);
process.exit(0);
