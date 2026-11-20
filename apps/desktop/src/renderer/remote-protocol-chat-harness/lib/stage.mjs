// What the real core needs around it, staged inside one run's explicit `paths` (env.mjs isolatedPaths) -- the same object the daemon's
// environment is built from: the bundled PostgreSQL published where a finished install would have put it (<dataDir>/runtime/runtime-<key>,
// `.version-sha256`, `active-version`), because the daemon downloads from GitHub when they do not match, and a fresh private pgdata made by
// initdb with the repository's own CLUSTER_CONF. Nothing is shared between runs and nothing is read from or written outside `paths`.
//
// The runtime is MIXDOG_PG_RUNTIME_ARCHIVE: the win32-x64 tar.gz of src/runtime/memory/data/runtime-manifest.json. Its bytes must hash to the
// manifest's sha256 before anything is extracted; the stamp is written here from that verified digest, never copied from a tree.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { daemonEnv } from './env.mjs';

const MANIFEST = new URL('../../../../../../src/runtime/memory/data/runtime-manifest.json', import.meta.url);
const CLUSTER_RS = new URL(
  '../../../../../../native/core/crates/mixdog-services/src/memory/pg/cluster.rs',
  import.meta.url
);

function run(command, args, paths, cwd) {
  const out = spawnSync(command, args, {
    encoding: 'utf8',
    env: daemonEnv(paths),
    cwd,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) throw new Error(`${command} ${args[0]} failed (${out.status}): ${out.stderr || out.error}`);
  return out.stdout;
}

/** Stages the verified runtime and a fresh cluster under `paths.dataDir`; returns the runtime key. */
export function seedPgRuntime(paths, archive = process.env.MIXDOG_PG_RUNTIME_ARCHIVE) {
  if (!archive || !existsSync(archive))
    throw new Error(
      `MIXDOG_PG_RUNTIME_ARCHIVE must name the win32-x64 runtime tar.gz (got ${JSON.stringify(archive)})`
    );
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const asset = manifest.assets['win32-x64'];
  const bytes = readFileSync(archive);
  if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw new Error(
      'MIXDOG_PG_RUNTIME_ARCHIVE does not match the size and sha256 of the win32-x64 asset in runtime-manifest.json'
    );
  const pkg = JSON.parse(readFileSync(new URL('./pg-version.json', import.meta.url), 'utf8'));
  if (pkg.version !== `pg${manifest.pg.major}.${manifest.pg.minor}+pgvector-${manifest.pgvector.version}`)
    throw new Error('pg-version.json does not match runtime-manifest.json');
  const conf = /const CLUSTER_CONF: &str = "([\s\S]*?)";/.exec(readFileSync(CLUSTER_RS, 'utf8'))?.[1];
  if (conf === undefined) throw new Error(`CLUSTER_CONF not found in ${CLUSTER_RS.pathname}`);

  const key = `${pkg.version}-${asset.sha256.slice(0, 12)}`;
  const base = join(paths.dataDir, 'runtime');
  const runtimeDir = join(base, `runtime-${key}`);
  const pgdata = join(paths.dataDir, 'pgdata');
  if (existsSync(runtimeDir) || existsSync(pgdata)) throw new Error(`${paths.dataDir} is not a fresh run root`);

  const staging = join(paths.tmp, `pg-runtime-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'tree'), { recursive: true });
  mkdirSync(base, { recursive: true });
  const tar = join(daemonEnv(paths).SystemRoot, 'System32', 'tar.exe');
  const stagedArchive = join(staging, 'runtime.tar.gz');
  writeFileSync(stagedArchive, bytes);
  const names = run(tar, ['-tzf', 'runtime.tar.gz'], paths, staging).split(/\r?\n/).filter(Boolean);
  if (names.some((name) => /^([a-z]:|[\\/])/i.test(name) || name.split(/[\\/]/).includes('..')))
    throw new Error('runtime archive has an entry outside its root');
  run(tar, ['-xzf', '../runtime.tar.gz'], paths, join(staging, 'tree'));
  if (
    !existsSync(join(staging, 'tree', 'bin', 'initdb.exe')) ||
    !existsSync(join(staging, 'tree', 'bin', 'postgres.exe'))
  )
    throw new Error('runtime archive lacks bin/initdb.exe or bin/postgres.exe');
  writeFileSync(join(staging, 'tree', '.version-sha256'), asset.sha256);
  renameSync(join(staging, 'tree'), runtimeDir);
  rmSync(staging, { recursive: true, force: true });
  writeFileSync(join(base, 'active-version'), key);

  run(
    join(runtimeDir, 'bin', 'initdb.exe'),
    ['-D', pgdata, '--auth-local=trust', '--no-locale', '-E', 'UTF8', '-U', 'postgres'],
    paths,
    paths.tmp
  );
  const confPath = join(pgdata, 'postgresql.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8') + conf);
  return key;
}
