// Applies only verified index changes. No table rewrite, row deletion,
// retention change, vector rebuild or memory-service bootstrap is performed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { prepareSessionIndexes, commitSessionIndexes } from '../src/runtime/memory/lib/pg/compact-indexes.mjs';

const workspace = resolve(process.argv[2]);
const readJson = async (name) => JSON.parse(await readFile(join(workspace, name), 'utf8'));
const manifest = await readJson('manifest.json');
const verification = await readJson('verification.json');
const decisions = await readJson('decisions.json');
assert.equal(manifest.prepared, true);
assert.deepEqual(verification.failures, []);
assert.equal(decisions.memoryBtreeRestored, true);
assert.equal(createHash('sha256').update(await readFile(manifest.dump)).digest('hex'), manifest.dumpSha256);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const client = new pg.Client({
    host: '127.0.0.1', port: manifest.sourcePort, database: 'mixdog', user: 'postgres', password: '',
    application_name: 'mixdog-pg-diet-index-maintenance', connectionTimeoutMillis: 5000,
});

async function footprint() {
    return (await client.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
        (SELECT SUM(pg_relation_size(c.oid))::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname IN ('memory','trace') AND c.relkind='i') AS index_bytes`)).rows[0];
}
async function tableIdentity() {
    return (await client.query(`SELECT c.oid::text,n.nspname,c.relname,c.relfilenode::text
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('memory','trace') AND c.relkind IN ('r','m')
        ORDER BY n.nspname,c.relname`)).rows;
}
async function hnswIdentity() {
    return (await client.query(`SELECT c.oid::text,pg_get_indexdef(c.oid) AS definition
        FROM pg_class c JOIN pg_am a ON a.oid=c.relam JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('memory','trace') AND a.amname='hnsw' ORDER BY c.oid`)).rows;
}
const receipt = { completed: [], startedAt: new Date().toISOString(), backup: manifest.dump };
try {
    await client.connect();
    const sourceDir = (await client.query('SHOW data_directory')).rows[0].data_directory;
    assert.equal(resolve(sourceDir).toLowerCase(), resolve(join(dirname(workspace), 'pgdata')).toLowerCase());
    assert.notEqual(resolve(sourceDir).toLowerCase(), resolve(manifest.cloneDir).toLowerCase());
    const tables = await tableIdentity();
    const hnsw = await hnswIdentity();
    receipt.before = await footprint();
    const plans = [];
    for (const target of decisions.reindex) {
        assert.ok(['memory','trace'].includes(target.schema));
        const detail = (await client.query(`SELECT c.oid::text,pg_get_indexdef(c.oid) AS definition,
            a.amname AS method,x.indisvalid,pg_relation_size(c.oid)::text AS bytes
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_index x ON x.indexrelid=c.oid JOIN pg_am a ON a.oid=c.relam
            WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='i'`,
        [target.schema,target.name])).rows[0];
        assert.ok(detail?.indisvalid && detail.method === target.method);
        assert.ok(['btree','gin'].includes(detail.method));
        plans.push({ ...target, ...detail });
    }
    // Preserve exact current definitions for a rollback that retains new rows.
    // Restoring the whole older dump over a live database is NOT a rollback.
    await writeFile(join(workspace, 'live-indexes-before.json'), JSON.stringify(plans, null, 2));
    const sessionPlans = await prepareSessionIndexes(client);
    await writeFile(join(workspace, 'live-session-indexes-before.json'), JSON.stringify(sessionPlans, null, 2));
    await commitSessionIndexes(client, sessionPlans);
    receipt.sessionIndexes = sessionPlans.map((p) => `${p.schema}.${p.name}`);
    await writeFile(join(workspace, 'apply-progress.json'), JSON.stringify(receipt, null, 2));
    for (const target of plans) {
        const name = `${quote(target.schema)}.${quote(target.name)}`;
        const current = (await client.query('SELECT pg_get_indexdef($1::regclass) AS definition',
            [`${target.schema}.${target.name}`])).rows[0].definition;
        assert.equal(current, target.definition, `Index changed before maintenance: ${name}`);
        await client.query(`REINDEX INDEX CONCURRENTLY ${name}`);
        const after = (await client.query(`SELECT pg_get_indexdef($1::regclass) AS definition,
            pg_relation_size($1::regclass)::text AS bytes,
            (SELECT indisvalid FROM pg_index WHERE indexrelid=$1::regclass) AS valid`,
        [`${target.schema}.${target.name}`])).rows[0];
        assert.equal(after.definition, target.definition);
        assert.equal(after.valid, true);
        receipt.completed.push({ index: `${target.schema}.${target.name}`, beforeBytes: Number(target.bytes),
            afterBytes: Number(after.bytes) });
        await writeFile(join(workspace, 'apply-progress.json'), JSON.stringify(receipt, null, 2));
    }
    assert.deepEqual(await tableIdentity(), tables, 'A table was replaced during maintenance');
    assert.deepEqual(await hnswIdentity(), hnsw, 'A vector index was replaced during maintenance');
    receipt.after = await footprint();
    receipt.tablesUntouched = true;
    receipt.vectorIndexesUntouched = true;
    receipt.finishedAt = new Date().toISOString();
    await writeFile(join(workspace, 'applied.json'), JSON.stringify(receipt, null, 2));
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally { await client.end(); }
