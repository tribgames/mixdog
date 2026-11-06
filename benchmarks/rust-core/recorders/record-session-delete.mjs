#!/usr/bin/env node
// Golden of a populated session's delete: the files a 1.4.5 daemon's real `deleteSession` removes,
// edits and keeps (`native/core/fixtures/session-delete/populated_delete.json`). Real Node code
// writes the state (the store, the tool-result offload, read snapshots, baselines, turn records,
// the transcript writer, scratch folders, the warm stores) and real `deleteSession` runs every
// purge hook the daemon's module graph registers. Rust `PurgeHooks` must leave the same files
// (`mixdog-core/tests/purge_populated_delete.rs`).
//
//   node benchmarks/rust-core/recorders/record-session-delete.mjs --tree <dir>
//
// Three sessions share one data folder: `sess_victim` (fully populated, with a turn record),
// `sess_cleared` (a "history deleted" marker instead of a turn record) and `sess_keeper` (never
// deleted: everything of it must survive). The golden lists every file of the folder (relative to
// the home) with its content before and after both deletes, as UTF-8 text.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const home = mkdtempSync(join(tmpdir(), 'mixdog-populated-delete-'));
const data = join(home, 'data');
mkdirSync(join(data, 'sessions'), { recursive: true });
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
// A fixed working folder: the transcript's project folder is named after it, so a golden
// recorded under a random temp folder could not be compared.
const cwd = 'C:\\mixdog-golden\\project';
const filesDir = join(home, 'files');
mkdirSync(filesDir, { recursive: true });

const hooks = `data:text/javascript,${encodeURIComponent(`
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.endsWith('/standalone/daemon.mjs')) {
    return { ...result, source: String(result.source).replace(/\\nmain\\(\\)\\.catch\\(/, '\\nif (false) main().catch(') };
  }
  return result;
}`)}`;
register(hooks, import.meta.url);
const at = (p) => pathToFileURL(join(repo, p)).href;

// The daemon's module graph registers the purge hooks; the transcript hook is registered the way
// the daemon registers it, its memory-offset request recorded.
await import(at('src/standalone/daemon.mjs'));
await import(at('src/standalone/local-session-runtime.mjs'));
await import(at('src/session-runtime/runtime-core.mjs'));
const forgotten = [];
(await import(at('src/session-runtime/session-transcript-purge.mjs'))).registerTranscriptPurgeHook({
  forgetOffsets: async (paths) => {
    forgotten.push(...paths);
  },
});
const store = await import(at('src/runtime/agent/orchestrator/session/store.mjs'));
const summaryIndex = await import(at('src/runtime/agent/orchestrator/session/store-summary-index.mjs'));
const offload = await import(at('src/runtime/agent/orchestrator/session/tool-result-offload.mjs'));
const snapshots = await import(at('src/runtime/agent/orchestrator/tools/builtin/snapshot-store.mjs'));
const baselines = await import(at('src/runtime/shared/session-baseline-store.mjs'));
const turnStore = await import(at('src/runtime/shared/turn-snapshot-store.mjs'));
const transcript = await import(at('src/runtime/shared/transcript-writer.mjs'));
const buffered = await import(at('src/runtime/shared/buffered-appender.mjs'));
const scratch = await import(at('src/runtime/shared/session-scratch.mjs'));
const touches = await import(at('src/runtime/agent/orchestrator/session/prompt-cache-touch-store.mjs'));

const record = (id) => ({
  id,
  owner: 'user',
  agent: 'lead',
  sourceType: 'lead',
  closed: false,
  generation: 0,
  updatedAt: 10,
  cwd,
  messages: [{ role: 'user', content: `hello ${id}` }],
});
const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const touchedFile = join(filesDir, 'src.txt');
write(touchedFile, 'after\n');

const ids = ['sess_victim', 'sess_cleared', 'sess_keeper'];
for (const id of ids) {
  await store.saveSessionDurably(record(id));
  offload.persistToolResultArtifactSync({ sessionId: id, toolCallId: 'call_1', content: `result of ${id}` });
  const stat = statSync(touchedFile);
  snapshots.rememberReadSnapshot(
    touchedFile,
    { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino, dev: stat.dev, contentHash: 'ab12' },
    id
  );
  snapshots.releaseReadSnapshotScope(id);
  baselines.captureSessionBaselines(id, [{ path: touchedFile, root: cwd, before: 'before\n' }]);
  const writer = transcript.createTranscriptWriter({ mixdogHome: home, sessionId: id, cwd });
  writer.appendUser(`hi ${id}`);
  buffered.drainPathSync(writer.transcriptPath);
  write(`${writer.transcriptPath}.1`, `rotated ${id}\n`);
  write(join(data, 'sessions', `${id}.compaction-archive.jsonl`), `{"v":1,"seq":1,"id":"${id}"}\n`);
  write(join(data, 'sessions', `${id}.compaction-archive.pending`), `{"v":1,"jobs":[]}`);
  write(join(scratch.ensureSessionScratchDir(id), 'tmp.txt'), 'scratch');
  write(join(data, 'scratch', id, 'legacy.txt'), 'legacy scratch');
  touches.promptCacheTouchStore().record(id, { touchAt: 5_000, ttlMs: 300_000, promptTokens: 100, accountId: 'acc' });
  touches.promptCacheTouchStore().recordWarmUse(id, 6_000, { provider: 'anthropic-oauth', model: 'm', accountId: 'acc' });
}
// A file in the offload folder that is not a result, left by the delete.
write(join(data, 'tool-results', 'sess_victim', 'notes.md'), 'kept');
baselines.recordReviewOwner('sess_victim', 'sess_keeper');
baselines.recordReviewOwner('sess_cleared', 'sess_keeper');
write(
  join(data, 'connector-accounts-by-conversation.json'),
  JSON.stringify({
    sess_victim: { accounts: { gmail: { name: 'a@example.com', id: 'acc1' } } },
    sess_cleared: { accounts: { gmail: { name: 'a@example.com', id: 'acc1' } } },
    sess_keeper: { accounts: { gmail: { name: 'b@example.com', id: 'acc2' } } },
  })
);
await baselines._settleSessionBaselinesForTest();
await touches.promptCacheTouchStore().flush();
// The idle-gap store the warm hook drops the session from loads this file on first use.
const gapFile = join(data, 'prompt-cache-idle-gaps.json');
write(
  gapFile,
  JSON.stringify({
    version: 1,
    sessions: Object.fromEntries(ids.map((id) => [id, { open: Date.now(), gaps: [{ at: Date.now(), ms: 70_000 }] }])),
  })
);
// A turn record for the victim; a deleted history (the marker) for the other.
await turnStore.saveTurnSnapshotRecord('sess_victim', { generation: 1, root: filesDir, baselineTree: 'tree1', toolFiles: ['src.txt'] });
await turnStore.saveTurnSnapshotRecord('sess_keeper', { generation: 1, root: filesDir, baselineTree: 'tree2', toolFiles: ['src.txt'] });
await turnStore.clearSessionChangeHistory('sess_cleared');

const listing = () => {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(home, full).replace(/\\/g, '/'), readFileSync(full, 'utf8'));
    }
  };
  walk(home);
  return out;
};
const settled = async () => {
  await summaryIndex.settleSummaryIndexWrites();
  let last = '';
  for (let stable = 0; stable < 4; ) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const now = createHash('sha256').update(JSON.stringify([...listing()])).digest('hex');
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
};
await settled();
const before = listing();
for (const id of ['sess_victim', 'sess_cleared']) {
  if ((await store.deleteSession(id, { fenceWrites: true })) !== true) throw new Error(`delete of ${id} failed`);
}
await settled();
const after = listing();

const files = {};
for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
  files[path] = { before: before.get(path) ?? null, after: after.get(path) ?? null };
}
// The temp folder's spellings inside file contents (raw, as JSON-escaped text, with slashes,
// folded to lower case as the baseline keys are) become `<home>`.
const spellings = [home, home.replace(/\\/g, '\\\\'), home.replace(/\\/g, '/'), home.replace(/\\/g, '/').toLowerCase()];
const anonymous = (text) => (text === null ? null : spellings.reduce((out, spelling) => out.split(spelling).join('<home>'), text));
for (const entry of Object.values(files)) {
  entry.before = anonymous(entry.before);
  entry.after = anonymous(entry.after);
}
const golden = {
  sessions: ids,
  cwd,
  offsetsForgotten: forgotten.map((p) => relative(home, p).replace(/\\/g, '/')).sort(),
  files,
};
(await import(at('src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs'))).releaseHeldSessionWriters();
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

writeJson(join(FIXTURES_ROOT, 'session-delete', 'populated_delete.json'), golden);
writeSetManifest(join(FIXTURES_ROOT, 'session-delete'), {
  set: 'session-delete',
  recorder: 'benchmarks/rust-core/recorders/record-session-delete.mjs',
  command: 'node benchmarks/rust-core/recorders/record-session-delete.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${Object.keys(files).length} files`);
process.exit(0);
