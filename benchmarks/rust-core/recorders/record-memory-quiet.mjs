#!/usr/bin/env node
// Golden twin of `MIXDOG_QUIET_MEMORY_LOG` (set by `ensureStandaloneEnvironment`, seeds.mjs): Node's stderr in one memory scenario,
// with the standalone defaults and without them. The scenario is the real `ensureRuntime` (memory/lib/runtime-fetcher.mjs) on a
// win32-arm64 host whose data dir already holds the runtime, which writes the `[runtime-fetcher] ... under emulation` line through
// `__mixdogMemoryLog` before it reuses the cached tree. Each run is a fresh Node process, so its stderr is exactly what Node printed.
// Replayed by `mixdog-services` `memory/pg/runtime_install/quiet_log_tests.rs`.
//
//   node benchmarks/rust-core/recorders/record-memory-quiet.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitCheckoutIdentity, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

if (process.argv[2] === '--child') {
  // argv: --child <tree> <dataDir> <standalone|bare>
  const [, , , tree, dataDir, mode] = process.argv;
  Object.defineProperty(process, 'arch', { value: 'arm64' });
  delete process.env.MIXDOG_QUIET_MEMORY_LOG;
  if (mode === 'standalone') {
    const { ensureStandaloneEnvironment } = await import(pathToFileURL(join(tree, 'src/session-runtime/services/seeds.mjs')).href);
    ensureStandaloneEnvironment({ rootDir: join(tree, 'src'), dataDir });
  }
  const { ensureRuntime } = await import(pathToFileURL(join(tree, 'src/runtime/memory/lib/runtime-fetcher.mjs')).href);
  const result = await ensureRuntime(dataDir);
  process.stdout.write(JSON.stringify({ runtimeDir: relative(dataDir, result.runtimeDir).split('\\').join('/'), version: result.version }));
} else {
  const cli = parseArgs();
  const tree = resolveTree(cli);
  const commit = cli.get('commit');
  const identity = commitCheckoutIdentity(tree, commit);
  const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'memory-quiet');
  const stage = stageSet(outDir);

  const manifestText = readFileSync(join(tree, 'src/runtime/memory/data/runtime-manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const version = `pg${manifest.pg.major}.${manifest.pg.minor}+pgvector-${manifest.pgvector.version}`;
  const sha256 = manifest.assets['win32-x64'].sha256;
  const key = `${version}-${sha256.slice(0, 12)}`;
  const seed = [
    { path: 'runtime/active-version', text: key },
    { path: `runtime/runtime-${key}/.version-sha256`, text: sha256 },
    { path: `runtime/runtime-${key}/bin/postgres.exe`, text: 'x' },
  ];
  const work = mkdtempSync(join(tmpdir(), 'memory-quiet-'));
  const runs = {};
  for (const mode of ['standalone', 'bare']) {
    const dataDir = join(work, mode);
    for (const entry of seed) {
      mkdirSync(join(dataDir, entry.path, '..'), { recursive: true });
      writeFileSync(join(dataDir, entry.path), entry.text);
    }
    const ran = spawnSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--child', tree, dataDir, mode], { encoding: 'utf8' });
    if (ran.status !== 0) throw new Error(`${mode}: exit ${ran.status}\n${ran.stderr}`);
    runs[mode] = { stderr: ran.stderr, result: JSON.parse(ran.stdout) };
  }
  writeJson(join(stage, 'twin.json'), { recordedOn: `${process.platform}-arm64(faked arch)`, manifest: manifestText, seed, runs });
  writeSetManifest(stage, {
    set: 'memory-quiet',
    recorder: 'benchmarks/rust-core/recorders/record-memory-quiet.mjs',
    command: `node benchmarks/rust-core/recorders/record-memory-quiet.mjs --tree <git checkout of ${commit}> --commit ${commit}`,
    identity,
  });
  commitStage(stage, outDir);
  rmSync(work, { recursive: true, force: true });
  console.log(`memory-quiet: ${Object.keys(runs).join(', ')} -> ${outDir}`);
}
