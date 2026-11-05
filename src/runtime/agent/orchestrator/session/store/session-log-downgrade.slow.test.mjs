// Downgrade compatibility: sessions migrated to logs by this build stay
// visible, unchanged, to v1.4.5; a session v1.4.5 then writes is found
// diverged by this build and rebased from its json, with the old log kept.
//
// The v1.4.5 side is the real release. MIXDOG_V145_DIR names a checkout or
// read-only worktree of tag v1.4.5 (git worktree add --detach <dir> v1.4.5);
// without it the tag's `src` is exported with `git archive` into a scoped
// scratch dir. Either needs the release's dependencies to be resolvable (the
// export links this checkout's node_modules; nothing is installed); when they
// are not, the test is skipped and names the missing package.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';
import { LEGACY_SESSION_LOADER, loadLegacySession as loadLegacy } from './legacy-session.mjs';
import { jsonEqual } from './session-log-format.mjs';
import { migrateLegacySessions, sessionLogMigrationProgressPath } from './session-log-migration.mjs';
import { resolveSessionRecord } from './session-log-reader.mjs';
import { convertLegacySession } from './session-log-writer.mjs';

const REPO = fileURLToPath(new URL('../../../../../../', import.meta.url));
const TAG = 'v1.4.5';
const CHILD = fileURLToPath(new URL('./session-log-downgrade.fixture.mjs', import.meta.url));
const dataDir = process.env.MIXDOG_DATA_DIR;
const storeDir = join(dataDir, 'sessions');
const claim = { assertHeld() {} };

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
}

// The v1.4.5 tree: an explicit checkout, or the tag exported into scratch.
function v145Tree() {
  if (process.env.MIXDOG_V145_DIR) return process.env.MIXDOG_V145_DIR;
  try {
    git('rev-parse', '--verify', `${TAG}^{commit}`);
  } catch {
    return null;
  }
  const dir = makeTempDirSync('v145-snapshot');
  git('archive', '--format=tar', '-o', join(dir, 'v145.tar'), TAG, 'src', 'package.json');
  execFileSync('tar', ['-xf', join(dir, 'v145.tar'), '-C', dir]);
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'junction');
  return dir;
}

function runV145(storeUrl, op, args = {}) {
  const run = spawnSync(process.execPath, [CHILD, storeUrl, op, JSON.stringify(args)], {
    env: { ...process.env, MIXDOG_DATA_DIR: dataDir, MIXDOG_USER_DATA_BACKUP_ROOT: join(dataDir, 'backups') },
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ...run, json: run.status === 0 ? JSON.parse(run.stdout) : null };
}

function snapshot(suffix) {
  return Object.fromEntries(
    readdirSync(storeDir)
      .filter((name) => name.endsWith(suffix))
      .map((name) => [name, { bytes: readFileSync(join(storeDir, name)), mtimeMs: statSync(join(storeDir, name)).mtimeMs }])
  );
}

const SEEDS = ['sess_downgrade_a', 'sess_downgrade_b', 'sess_downgrade_c'].map((id, i) => ({
  id,
  generation: 1,
  closed: false,
  title: `session ${i}`,
  updatedAt: 1000 + i,
  messages: [
    { role: 'user', content: `question ${i}` },
    { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] },
    ...Array.from({ length: i * 3 }, (_, n) => ({ role: 'user', content: `follow-up ${i}.${n}` })),
  ],
}));
const IDS = SEEDS.map((session) => session.id);
const jsonPath = (id) => join(storeDir, `${id}.json`);
const logPath = (id) => join(storeDir, `${id}.log.jsonl`);

test('a downgrade to v1.4.5 sees sessions as at the upgrade, and its write is rebased from the json', { timeout: 600_000 }, async (t) => {
  const tree = v145Tree();
  if (!tree) return t.skip(`tag ${TAG} is not in this clone (fetch tags to run the downgrade test)`);
  assert.equal(JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).version, TAG.slice(1));
  const storeUrl = pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/session/store.mjs')).href;

  const probe = runV145(storeUrl, 'probe');
  const missing = /Cannot find package '([^']+)'/.exec(probe.stderr)?.[1];
  if (missing) return t.skip(`the ${TAG} snapshot needs its dependencies installed (cannot find package '${missing}')`);
  if (probe.status !== 0) assert.fail(`probe failed (${probe.status}): ${probe.stderr}`);

  // Sessions written by v1.4.5 itself.
  const seeded = runV145(storeUrl, 'seed', { sessions: SEEDS });
  if (seeded.status !== 0) assert.fail(`seed failed (${seeded.status}): ${seeded.stderr}`);
  const jsonAtUpgrade = snapshot('.json');
  assert.deepEqual(Object.keys(jsonAtUpgrade).sort(), IDS.map((id) => `${id}.json`));
  const atUpgrade = runV145(storeUrl, 'view', { ids: IDS });
  assert.equal(atUpgrade.status, 0, atUpgrade.stderr);
  assert.deepEqual(atUpgrade.json.listed, IDS);
  for (const id of IDS) assert.ok(atUpgrade.json.sessions[id]?.messages.length >= 2, id);

  // This build migrates them; no json is touched.
  const report = await migrateLegacySessions({
    storeDir,
    progressPath: sessionLogMigrationProgressPath(dataDir),
    loader: LEGACY_SESSION_LOADER,
    claimFor: () => ({ held: true, claim }),
  });
  assert.equal(report.migrated, IDS.length);
  assert.equal(report.complete, true);
  assert.deepEqual(snapshot('.json'), jsonAtUpgrade);
  const logsAtUpgrade = snapshot('.log.jsonl');
  assert.deepEqual(Object.keys(logsAtUpgrade).sort(), IDS.map((id) => `${id}.log.jsonl`));

  // v1.4.5 sees exactly what it saw before, and leaves every file alone.
  const afterMigration = runV145(storeUrl, 'view', { ids: IDS });
  assert.equal(afterMigration.status, 0, afterMigration.stderr);
  assert.deepEqual(afterMigration.json, atUpgrade.json);
  assert.deepEqual(snapshot('.json'), jsonAtUpgrade);
  assert.deepEqual(snapshot('.log.jsonl'), logsAtUpgrade, 'v1.4.5 does not touch, move or delete a log');

  // v1.4.5 writes one session.
  const [target, ...others] = IDS;
  const written = runV145(storeUrl, 'write', {
    id: target,
    message: { role: 'user', content: 'written by v1.4.5' },
    title: 'retitled by v1.4.5',
  });
  assert.equal(written.status, 0, written.stderr);
  const jsonAfterWrite = snapshot('.json');
  assert.notDeepEqual(jsonAfterWrite[`${target}.json`].bytes, jsonAtUpgrade[`${target}.json`].bytes);
  for (const id of others) assert.deepEqual(jsonAfterWrite[`${id}.json`], jsonAtUpgrade[`${id}.json`], id);

  // This build finds it diverged and loses nothing.
  const before = await resolveSessionRecord({ jsonPath: jsonPath(target), logPath: logPath(target), loadLegacy });
  assert.equal(before.kind, 'diverged');
  const fromJson = loadLegacy(readFileSync(jsonPath(target), 'utf8'), target);
  assert.ok(jsonEqual(before.session, fromJson));
  assert.equal(fromJson.title, 'retitled by v1.4.5');
  const oldLog = readFileSync(logPath(target));
  const oldMessages = before.log.messages;
  for (const id of others) {
    assert.equal((await resolveSessionRecord({ jsonPath: jsonPath(id), logPath: logPath(id), loadLegacy })).kind, 'log', id);
  }

  const rebased = await convertLegacySession({
    jsonPath: jsonPath(target),
    logPath: logPath(target),
    loadLegacy,
    claim,
    divergedLogId: before.log.logId,
  });
  assert.deepEqual(readFileSync(rebased.aside), oldLog, 'the diverged log is kept whole');
  const now = await resolveSessionRecord({ jsonPath: jsonPath(target), logPath: logPath(target), loadLegacy });
  assert.equal(now.kind, 'log');
  assert.ok(jsonEqual(now.session, fromJson), 'the new log replays to the v1.4.5 json');
  assert.ok(jsonEqual(now.session.messages.slice(0, oldMessages.length), oldMessages), 'every message of the old log is still there');
  assert.equal(now.session.messages.at(-1).content, 'written by v1.4.5');
  assert.deepEqual(snapshot('.json'), jsonAfterWrite, 'the rebase does not touch the json');

  // The set-aside copy and the other logs survive another v1.4.5 pass.
  const again = runV145(storeUrl, 'view', { ids: IDS });
  assert.equal(again.status, 0, again.stderr);
  assert.ok(existsSync(rebased.aside));
  assert.deepEqual(readFileSync(rebased.aside), oldLog);
  for (const id of others) assert.deepEqual(readFileSync(logPath(id)), logsAtUpgrade[`${id}.log.jsonl`].bytes, id);
});
