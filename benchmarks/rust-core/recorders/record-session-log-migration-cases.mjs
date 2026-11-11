#!/usr/bin/env node
// Records Node's legacy session migration for the k1 UNTESTED session-log-migration.test.mjs (gaps-rest.md:
// mixdog-migrate). Each case runs the test's steps through Node's real `migrateLegacySessions` with the product's
// legacy loader (`LEGACY_SESSION_LOADER`, where the test passes its fixture loader), and records what a client
// observes once the steps are done: every session as Node's reader reads it from its log, whether every legacy json
// is byte- and mtime-identical, and the leftover `.tmp` files.
//
//   node benchmarks/rust-core/recorders/record-session-log-migration-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/session-log-migration-cases/{golden.json,MANIFEST.json}.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-session-log-migration-cases.mjs';
const TEST = 'src/runtime/agent/orchestrator/session/store/session-log-migration.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = mkdtempSync(join(tmpdir(), 'mixdog-session-log-migration-cases-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const STORE = 'src/runtime/agent/orchestrator/session/store';
const { migrateLegacySessions } = await importFrom(tree, `${STORE}/session-log-migration.mjs`);
const { LEGACY_SESSION_LOADER, loadLegacySession } = await importFrom(tree, `${STORE}/legacy-session.mjs`);
const { convertLegacySession } = await importFrom(tree, `${STORE}/session-log-writer.mjs`);
const { readSessionLog } = await importFrom(tree, `${STORE}/session-log-reader.mjs`);

const heldClaim = { assertHeld() {} };
const held = () => ({ held: true, claim: heldClaim });
const loader = LEGACY_SESSION_LOADER;

// The test's documents, each with the system message every product session opens with.
const docs = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `sess_${String(i).padStart(3, '0')}`,
    title: `t${i}`,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: `m${i}` },
    ],
  }));

function store(name, list) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const files = {};
  for (const doc of list) {
    const text = JSON.stringify(doc);
    writeFileSync(join(dir, `${doc.id}.json`), text);
    files[`${doc.id}.json`] = text;
  }
  return { dir, progressPath: join(root, `${name}-progress.json`), files };
}

function snapshot(dir) {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => [name, `${readFileSync(join(dir, name)).toString('base64')}@${statSync(join(dir, name)).mtimeMs}`])
  );
}

async function observe(dir, before) {
  const sessions = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.log.jsonl')).sort()) {
    const r = await readSessionLog(join(dir, name));
    sessions[name.slice(0, -'.log.jsonl'.length)] = { valid: r.valid, header: r.header, messages: r.messages };
  }
  return {
    sessions,
    jsonsUnchanged: JSON.stringify(snapshot(dir)) === JSON.stringify(before),
    tmp: readdirSync(dir).filter((name) => name.endsWith('.tmp')).length,
  };
}

const cases = [];

{
  const name = 'migrates every legacy json into a proven log, never touching a json, and resumes after an exit';
  const { dir, progressPath, files } = store('all', docs(6));
  const before = snapshot(dir);
  const controller = new AbortController();
  let published = 0;
  await migrateLegacySessions({
    storeDir: dir,
    progressPath,
    loader,
    claimFor: () => ({
      ...held(),
      release() {
        published += 1;
        if (published === 2) controller.abort();
      },
    }),
    signal: controller.signal,
  });
  await migrateLegacySessions({ storeDir: dir, progressPath, loader, claimFor: held });
  cases.push({ case: name, files, steps: ['interrupted', 'run'], observed: await observe(dir, before) });
}

{
  const name = 'a file that failed for lack of disk space is tried again at the next start';
  const { dir, progressPath, files } = store('enospc', docs(1));
  const before = snapshot(dir);
  const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  await migrateLegacySessions({
    storeDir: dir,
    progressPath,
    loader,
    claimFor: () => ({ held: true, claim: { assertHeld() { throw full; } } }),
  });
  const afterFailure = await observe(dir, before);
  await migrateLegacySessions({ storeDir: dir, progressPath, loader, claimFor: held });
  cases.push({ case: name, files, steps: ['disk full', 'run'], afterFailure, observed: await observe(dir, before) });
}

{
  const name = 'a session converted by its first write is left as it is';
  const { dir, progressPath, files } = store('touched', docs(2));
  await convertLegacySession({
    jsonPath: join(dir, 'sess_000.json'),
    logPath: join(dir, 'sess_000.log.jsonl'),
    loadLegacy: loadLegacySession,
    claim: heldClaim,
  });
  const log = readFileSync(join(dir, 'sess_000.log.jsonl'), 'utf8');
  const before = snapshot(dir);
  await migrateLegacySessions({ storeDir: dir, progressPath, loader, claimFor: held });
  cases.push({ case: name, files, logs: { sess_000: log }, steps: ['run'], observed: await observe(dir, before) });
}

const excluded = {
  'a busy session is skipped and retried at the next start':
    "equality impossible: the core migrates at boot under the data dir's owner lock, before it serves anything, so no " +
    'other writer can hold a session (Node migrates after boot, beside processes that may hold one); there is no busy state to skip',
  'a file that fails verification is skipped permanently until it changes':
    "the case needs Node's test loader (`unstableLoad`: a document that loads differently on every read); the product's " +
    'loader and the core read a json the same way every time, so no file fails this verification',
};

const finalDir = join(FIXTURES_ROOT, 'session-log-migration-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's legacy session migration at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'session-log-migration-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "after each case's steps: every session as Node's reader reads it from its log (valid, header, messages), whether " +
      'every legacy json kept its bytes and mtime, and the leftover .tmp files; the disk-full case also after its failed run',
    loader: "the product's LEGACY_SESSION_LOADER (the test passes its fixture loader); the claim is the test's held claim",
    excluded,
  },
});
commitStage(stage, finalDir);
rmSync(root, { recursive: true, force: true });
console.log(`session-log-migration-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
