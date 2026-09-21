// Backup and isolated validation harness. This command never starts Mixdog's
// memory service: its bootstrap/retention hooks must not touch the originals.
import { mkdtemp, writeFile, readFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { searchRelevantHybrid } from '../src/runtime/memory/lib/memory-recall-store.mjs';

const config = { host: '127.0.0.1', user: 'postgres', password: '', connectionTimeoutMillis: 5000 };
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const baselineCases = [
  { query: 'sqlite' },
  { query: '토큰 사용량' },
  { query: '메모리 검색' },
  { query: 'deployment', options: { projectScope: 'mixdog' } },
  { query: 'browser', options: { rootOnly: true } },
  { query: 'PG', options: { includeMembers: true } },
  { query: 'index cache', options: { limit: 12 } },
  { query: '백업', options: { latestByConcept: true } },
  { query: '%', options: { limit: 4 } },
  { query: '_', options: { limit: 4 } },
];

async function run(exe, args, outputFile = null) {
  // A daemon launched by pg_ctl can inherit its output handles. File-backed
  // output prevents those handles from keeping the preparation task alive.
  const output = outputFile ? await open(outputFile, 'wx') : null;
  try {
    return await new Promise((yes, no) => {
      const child = spawn(exe, args, {
        windowsHide: true,
        stdio: output ? ['ignore', output.fd, output.fd] : ['ignore', 'pipe', 'pipe'],
      });
      let detail = '';
      child.stdout?.on('data', (value) => {
        detail = (detail + value).slice(-12000);
      });
      child.stderr?.on('data', (value) => {
        detail = (detail + value).slice(-12000);
      });
      child.on('error', no);
      child.on('exit', (code, signal) => {
        if (code === 0) {
          yes(detail);
          return;
        }
        const log = outputFile ? `\nLog: ${outputFile}` : '';
        no(new Error(`${exe}: exit=${code} signal=${signal}\n${detail}${log}`));
      });
    });
  } finally {
    await output?.close();
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', yes);
  });
  const port = server.address().port;
  await new Promise((yes) => server.close(yes));
  return port;
}

export async function profile(client) {
  return (
    await client.query(`
        SELECT n.nspname AS schema,c.relname AS relation,c.relkind,am.amname AS method,
            pg_relation_size(c.oid)::text AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_am am ON am.oid=c.relam
        WHERE n.nspname IN ('memory','trace') AND c.relkind IN ('r','m','i')
        ORDER BY n.nspname,c.relname
    `)
  ).rows;
}

export async function fingerprint(client) {
  const tables = (
    await client.query(`
        SELECT n.nspname AS schema,c.relname AS name FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('memory','trace') AND c.relkind='r'
        ORDER BY 1,2
    `)
  ).rows;
  const result = {};
  for (const table of tables) {
    const name = `${quote(table.schema)}.${quote(table.name)}`;
    // Sorting row digests makes this independent of heap/index order.
    const { rows } = await client.query(`SELECT COUNT(*)::text AS records,
            md5(COALESCE(string_agg(digest,'' ORDER BY digest),'')) AS digest
            FROM (SELECT md5(to_jsonb(t)::text) AS digest FROM ${name} t) rows`);
    result[`${table.schema}.${table.name}`] = rows[0];
  }
  return result;
}

export async function recallCases(client, clock, cases = baselineCases) {
  const result = [];
  const originalNow = Date.now;
  Date.now = () => clock;
  const db = {
    query: (sql, params) => client.query(sql, params),
    async transaction(fn) {
      await client.query('BEGIN READ ONLY');
      try {
        const value = await fn(db);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  };
  try {
    await client.query("SET search_path=memory,public; SET timezone='UTC'");
    for (const entry of cases) {
      const start = performance.now();
      const rows = await searchRelevantHybrid(db, entry.query, entry.options || {});
      result.push({ ...entry, ms: Math.round(performance.now() - start), result: rows });
    }
  } finally {
    Date.now = originalNow;
  }
  return result;
}

export async function readManifest(workspace) {
  return JSON.parse(await readFile(join(workspace, 'manifest.json'), 'utf8'));
}

async function prepare(dataDir, runtimeDir, sourcePort) {
  const workspace = await mkdtemp(join(dataDir, 'pg-diet-'));
  const binary = (name) => join(runtimeDir, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  const cloneDir = join(workspace, 'clone');
  const dump = join(workspace, 'original.dump');
  const source = new pg.Client({
    ...config,
    port: sourcePort,
    database: 'mixdog',
    application_name: 'mixdog-pg-diet-backup',
    options: '-c default_transaction_read_only=on',
  });
  const manifest = { workspace, cloneDir, dump, runtimeDir, sourcePort, clock: Date.now(), port: await freePort() };
  await writeFile(join(workspace, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ phase: 'backup', workspace, sourcePort, clonePort: manifest.port }));
  try {
    await source.connect();
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL timezone='UTC'");
    const snapshot = (await source.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const locale = (await source.query("SELECT datcollate,datctype FROM pg_database WHERE datname='mixdog'")).rows[0];
    const originalProfile = await profile(source);
    const originalData = await fingerprint(source);
    await run(binary('pg_dump'), [
      '-h',
      config.host,
      '-p',
      String(sourcePort),
      '-U',
      config.user,
      '-d',
      'mixdog',
      '-Fc',
      '--snapshot',
      snapshot,
      '-f',
      dump,
    ]);
    await source.query('COMMIT');
    await writeFile(join(workspace, 'original-data.json'), JSON.stringify(originalData));
    await writeFile(join(workspace, 'original-profile.json'), JSON.stringify(originalProfile));
    manifest.dumpSha256 = createHash('sha256')
      .update(await readFile(dump))
      .digest('hex');
    console.log(JSON.stringify({ phase: 'restore', workspace }));
    await run(binary('initdb'), [
      '-D',
      cloneDir,
      '--auth=trust',
      '-U',
      'postgres',
      '-E',
      'UTF8',
      `--lc-collate=${locale.datcollate}`,
      `--lc-ctype=${locale.datctype}`,
    ]);
    await run(
      binary('pg_ctl'),
      [
        'start',
        '-w',
        '-D',
        cloneDir,
        '-l',
        join(workspace, 'clone.log'),
        '-o',
        `-h 127.0.0.1 -p ${manifest.port} -c shared_buffers=32MB -c max_connections=16 -c jit=off`,
      ],
      join(workspace, 'clone-control.log')
    );
    await writeFile(join(workspace, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await run(binary('pg_restore'), [
      '-h',
      config.host,
      '-p',
      String(manifest.port),
      '-U',
      config.user,
      '-d',
      'postgres',
      '--create',
      '--exit-on-error',
      dump,
    ]);
    const clone = new pg.Client({ ...config, port: manifest.port, database: 'mixdog' });
    try {
      await clone.connect();
      await clone.query("SET timezone='UTC'");
      const restored = await fingerprint(clone);
      if (JSON.stringify(restored) !== JSON.stringify(originalData))
        throw new Error('Restored records differ from the original snapshot');
      await writeFile(join(workspace, 'clone-profile.json'), JSON.stringify(await profile(clone)));
      const baseline = await recallCases(clone, manifest.clock);
      await writeFile(join(workspace, 'recall-baseline.json'), JSON.stringify(baseline));
      manifest.prepared = true;
      await writeFile(join(workspace, 'manifest.json'), JSON.stringify(manifest, null, 2));
      console.log(
        JSON.stringify(
          {
            phase: 'ready',
            ...manifest,
            verifiedTables: Object.keys(restored).length,
            recallCases: baseline.map(({ query, ms }) => ({ query, ms })),
          },
          null,
          2
        )
      );
    } finally {
      await clone.end();
    }
  } finally {
    await source.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'prepare' || !process.argv[3] || !process.argv[4]) {
    throw new Error('Usage: node scripts/pg-memory-diet.mjs prepare <data-dir> <runtime-dir> <source-port>');
  }
  await prepare(resolve(process.argv[3]), resolve(process.argv[4]), Number(process.argv[5]));
  process.stdout.write('PG_DIET_PREPARE_COMPLETE\n', () => process.exit(0));
}
