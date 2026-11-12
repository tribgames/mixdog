// The memory watcher's ingest of a conversation transcript, killed at each point between storing a line and saving its
// read position, then started again (gaps-session.md item 8, the restart question; review of gaps-session-rest item 6).
//
// The watcher is Node's own (`createTranscriptIngest`, wired as `memory/index.mjs:210` wires it: the memory database's
// `meta` row `state.transcript_offsets` through `getMetaValue` / `setMetaValue`) over its real store: the memory database
// `openDatabase` opens on a PostgreSQL cluster of its own (the bundled runtime named by `--pg-runtime`, a fresh data dir per
// point). Each run of the watcher is its own process:
//   kill      ingests the transcript and is killed (SIGKILL, no cleanup) right after its k-th row insert has returned:
//             k = 1 .. n, the last one the point between the last insert and the position save.
//   restart   a new process: loads the persisted positions and ingests the same file again, as the watcher does on start.
// After each, a reader process records what is on disk: every `entries` row whole (`to_jsonb`) and the `meta` positions
// blob. The transcript is the one Node's writer left for the restart scenario (`fixtures/session-transcript/writer.json`,
// case `restart-source`), the `<cwd>` it names replaced by the point's working directory and recorded back as `<cwd>`.
//
//   node benchmarks/rust-core/recorders/record-transcript-restart.mjs --tree <b6f10295a export> --pg-runtime <runtime dir>
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const RECORDER = 'benchmarks/rust-core/recorders/record-transcript-restart.mjs';
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SOURCE = 'native/core/fixtures/session-transcript/writer.json';
const OFFSETS_KEY = 'state.transcript_offsets';
const FILE = 'sess_restart.jsonl';

function sandboxEnv(home) {
  for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = home;
  process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
  process.env.TZ = 'UTC';
  globalThis.fetch = () => {
    throw new Error('the restart recording reaches no network');
  };
}

// One process of the watcher, or the reader, over the point's home.
async function phase(tree, home, mode, k, out, now) {
  sandboxEnv(home);
  Date.now = () => now;
  const at = (path) => import(pathToFileURL(join(tree, path)).href);
  const memory = await at('src/runtime/memory/lib/memory.mjs');
  const { createTranscriptIngest } = await at('src/runtime/memory/lib/transcript-ingest.mjs');
  const { shutdownOwnedPg } = await at('src/runtime/memory/lib/pg/adapter.mjs');
  const db = await memory.openDatabase(home, 384);
  const work = join(home, 'work');
  const file = join(work, FILE);
  if (mode === 'read') {
    const rows = await db.query('SELECT to_jsonb(e) AS row FROM entries e ORDER BY id');
    const positions = await memory.getMetaValue(db, OFFSETS_KEY, null);
    writeFileSync(out, JSON.stringify({ rows: rows.rows.map((r) => r.row), positions: positions === null ? null : JSON.parse(positions) }));
    await memory.closeDatabase(home);
    await shutdownOwnedPg({ timeoutMs: 15_000 });
    process.exit(0);
  }
  let inserts = 0;
  const watched =
    mode === 'kill'
      ? new Proxy(db, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key !== 'query') return typeof value === 'function' ? value.bind(target) : value;
            return async (sql, params) => {
              const result = await value.call(target, sql, params);
              if (/^\s*INSERT INTO entries\(/.test(sql)) {
                inserts += 1;
                if (inserts === k) process.kill(process.pid, 'SIGKILL');
              }
              return result;
            };
          },
        })
      : db;
  const ingest = createTranscriptIngest({
    getDb: () => watched,
    loadMeta: () => memory.getMetaValue(db, OFFSETS_KEY, '{}'),
    persistMeta: (json) => memory.setMetaValue(db, OFFSETS_KEY, json),
    projectsRoot: () => join(home, 'projects'),
    resolveProjectId: () => null,
    log: () => {},
  });
  await ingest.loadTranscriptOffsets();
  const count = await ingest.ingestTranscriptFile(file, { cwd: work });
  writeFileSync(out, JSON.stringify({ count }));
  await memory.closeDatabase(home);
  process.exit(0);
}

async function main() {
  const { FIXTURES_ROOT, REPO_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
  const args = parseArgs();
  const tree = resolveTree(args);
  if (args.has('phase')) return phase(tree, args.get('home'), args.get('phase'), Number(args.get('k')), args.get('out'), Number(args.get('now')));
  const { recorderProvenance } = await import('./lib/provenance.mjs');
  const runtime = args.get('pg-runtime');
  if (!runtime) throw new Error('pass --pg-runtime <the bundled postgres runtime dir>');
  const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
  const writer = JSON.parse(readFileSync(join(REPO_ROOT, SOURCE), 'utf8'));
  const source = writer.cases.find((c) => c.name === 'restart-source').file.text;
  const now = Date.parse(writer.now);
  const finalDir = join(FIXTURES_ROOT, 'transcript-restart');
  const stage = stageSet(finalDir);
  const scratch = mkdtempSync(join(tmpdir(), 'transcript-restart-'));
  let runs = 0;
  const run = (home, mode, k = 0) => {
    runs += 1;
    const out = join(scratch, `run-${runs}.json`);
    const child = spawnSync(process.execPath, [SELF, '--tree', tree, '--phase', mode, '--home', home, '--k', String(k), '--out', out, '--now', String(now)], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000 });
    // The killed watcher ends by its kill and writes nothing.
    if (mode === 'kill') {
      if (child.status === 0) throw new Error(`the watcher of point ${k} was not killed`);
      return null;
    }
    if (child.status !== 0) throw new Error(`${mode} of ${home} failed (${child.status})`);
    return JSON.parse(readFileSync(out, 'utf8'));
  };
  // A fresh home: its own cluster over the bundled runtime, and the transcript in its working directory.
  const homeFor = (label) => {
    const home = join(scratch, label);
    mkdirSync(join(home, 'runtime'), { recursive: true });
    symlinkSync(runtime, join(home, 'runtime', basename(runtime)), 'junction');
    writeFileSync(join(home, 'runtime', 'active-version'), readFileSync(join(runtime, '..', 'active-version')));
    const work = join(home, 'work');
    mkdirSync(work);
    const cwd = JSON.stringify(work).slice(1, -1);
    const text = source.split('<cwd>').join(cwd);
    writeFileSync(join(work, FILE), text);
    // The file's length follows the length of this machine's directory, so it is recorded beside the positions
    // that count it.
    return { home, fileBytes: Buffer.byteLength(text), named: (value) => JSON.parse(JSON.stringify(value).split(cwd).join('<cwd>')) };
  };
  // The watcher never killed: the rows a whole ingest stores, which number the points.
  const control = homeFor('control');
  const whole = run(control.home, 'restart');
  const unkilled = control.named({ fileBytes: control.fileBytes, count: whole.count, ...run(control.home, 'read') });
  const points = [];
  for (let k = 1; k <= unkilled.rows.length; k += 1) {
    const { home, fileBytes, named } = homeFor(`point-${k}`);
    run(home, 'kill', k);
    const killed = run(home, 'read');
    const restarted = run(home, 'restart');
    points.push(named({ k, fileBytes, atKill: killed, restart: { count: restarted.count, ...run(home, 'read') } }));
  }
  rmSync(scratch, { recursive: true, force: true });
  writeJson(join(stage, 'restart-kill.json'), { scenario: 'restart-kill', file: FILE, source: `${SOURCE} case restart-source`, positionsKey: OFFSETS_KEY, unkilled, points });
  writeSetManifest(stage, {
    set: 'transcript-restart',
    recorder: RECORDER,
    command: `node ${RECORDER} --tree <b6f10295a export> --pg-runtime <bundled postgres runtime dir>`,
    extra: { scenarios: ['restart-kill'], ...recorderProvenance(import.meta.url, [SOURCE]) },
    identity,
  });
  commitStage(stage, finalDir);
  console.log('recorded transcript-restart');
}
await main();
