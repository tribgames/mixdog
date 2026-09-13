/**
 * Import surviving originals without starting/repairing the trace service.
 * PostgreSQL is opened with transaction_read_only=on. Original files are never
 * rewritten. Request rows outrank overlapping turn/day summaries; incomplete
 * historical coverage stays explicit rather than inventing a missing balance.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeUsageRecord, usageRouteKind } from './usage-ledger.mjs';
import { priceUsage } from './cost.mjs';

async function optionalFile(path) {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function importTraceRow(row) {
    const payload = row.payload || {};
    const raw = row.kind === 'usage_raw';
    const input = raw ? row.input_tokens : row.inputTokens;
    const output = raw ? row.output_tokens : row.outputTokens;
    // The old PG 'usage' serializer discarded camelCase token fields.
    // Empty columns are unknown; importing them as zero would claim coverage.
    if (input == null || output == null) return null;
    const provider = row.provider || payload.provider;
    if (!provider || !row.model) return null;
    const ts = typeof row.ts === 'number' ? row.ts
        : /^\d+$/.test(String(row.ts)) ? Number(row.ts) : Date.parse(row.ts);
    return makeUsageRecord({
        ts, provider, model: row.model,
        inputTokens: input, outputTokens: output,
        uncachedInputTokens: raw ? row.uncached_input_tokens ?? payload.uncached_input_tokens : undefined,
        cacheReadTokens: raw ? row.cached_tokens : row.cacheReadTokens,
        cacheWriteTokens: raw ? row.cache_write_tokens : row.cacheWriteTokens,
        costUsd: raw ? undefined : row.costUsd,
        sessionId: row.session_id || row.sessionId,
        sourceType: row.sourceType || row.source_type || payload.sourceType || payload.source_type,
        responseId: row.response_id || payload.response_id,
        serviceTier: row.service_tier || payload.service_tier,
        durationMs: row.duration_ms || row.durationMs || row.duration,
        origin: raw ? 'trace' : 'gateway',
        historical: true,
    });
}

export function repriceRestoredDays(original) {
    const days = structuredClone(original || {});
    for (const day of Object.values(days)) {
        if (!day?.restored) continue;
        for (const key of ['costUsd', 'costBilled', 'costEstimated', 'costKnownTurns']) {
            day[key] = 0;
            if (day.conversation) day.conversation[key] = 0;
        }
        for (const route of Object.values(day.models || {})) {
            route.kind ||= usageRouteKind(route.provider || '');
            for (const [bucket, target] of [[route, day], [route.conversation, day.conversation]]) {
                if (!bucket || !target) continue;
                const price = route.kind === 'local' ? { costUsd: 0 } : priceUsage({
                    provider: route.provider, model: route.model,
                    uncachedInputTokens: bucket.input, outputTokens: bucket.output,
                    cacheReadTokens: bucket.cacheRead, cacheWriteTokens: bucket.cacheWrite,
                    historical: true,
                });
                bucket.costUsd = price.costUsd ?? 0;
                bucket.costBilled = 0;
                bucket.costEstimated = bucket.costUsd;
                bucket.costKnownTurns = price.costUsd === null ? 0 : bucket.turns || 0;
                target.costUsd += bucket.costUsd;
                target.costEstimated += bucket.costUsd;
                target.costKnownTurns += bucket.costKnownTurns;
            }
        }
    }
    return days;
}

export async function importUsageHistory(ledger, dataDir, { now = Date.now(), readTrace = readOriginalTrace } = {}) {
    // This is a snapshot of surviving originals, not a completeness claim.
    // liveSince is established BEFORE the first instrumented send, so that
    // send's diagnostic copy cannot also enter as historical usage.
    const until = Number(ledger.get('liveSince')) || now;
    if (Number(ledger.get('importedThrough')) >= until) return { skipped: true };
    const result = { inserted: 0, sourceRows: 0, unrecordableRows: 0, files: [], traceRows: 0 };
    const accept = (rows) => {
        const normalized = [];
        for (const raw of rows) {
            result.sourceRows += 1;
            const row = importTraceRow(raw);
            if (!row) { result.unrecordableRows += 1; continue; }
            if (row.ts < until) normalized.push(row);
        }
        result.inserted += ledger.record(normalized);
    };
    let names;
    try { names = await readdir(join(dataDir, 'history')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
    for (const name of names.filter((name) => /^agent-trace\.jsonl(?:\.\d+)?$/.test(name)).sort()) {
        const path = join(dataDir, 'history', name);
        const original = await readFile(path, 'utf8');
        const lines = original.split(/\r?\n/);
        const rows = [];
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            let row;
            try { row = JSON.parse(lines[i]); }
            catch { throw new Error(`Incomplete or invalid trace record: ${path}:${i + 1}`); }
            if (row.kind === 'usage_raw' || row.kind === 'usage') rows.push(row);
        }
        accept(rows);
        result.files.push({ path, sha256: createHash('sha256').update(original).digest('hex'), rows: rows.length });
    }
    // A present-but-unreachable original store is an import error, not absence.
    const traceRows = await readTrace(dataDir, until);
    result.traceRows = traceRows.length;
    accept(traceRows);
    const gateway = await optionalFile(join(dataDir, 'gateway-usage.local.json'));
    if (gateway) accept((JSON.parse(gateway).events || []).map((event) => ({
        ...event, kind: 'usage', session_id: event.sessionId,
    })));
    const legacy = await optionalFile(join(dataDir, 'usage-rollup.local.json'));
    if (legacy) ledger.preserveLegacyDays(repriceRestoredDays(JSON.parse(legacy).days));
    ledger.set('importedThrough', until);
    ledger.set('importReceipt', JSON.stringify({ ...result, until }));
    return result;
}

export async function readOriginalTrace(dataDir, until) {
    const pidFile = await optionalFile(join(dataDir, 'pgdata', 'postmaster.pid'));
    if (!pidFile) return [];
    const fields = pidFile.trimEnd().split(/\r?\n/);
    const port = Number(fields[3]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid trace database port');
    const { default: pg } = await import('pg');
    const client = new pg.Client({
        host: '127.0.0.1', port, user: 'postgres', database: 'mixdog', password: '',
        application_name: 'mixdog-usage-import-readonly', connectionTimeoutMillis: 5000,
        options: '-c default_transaction_read_only=on -c statement_timeout=30000',
    });
    try {
        await client.connect();
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { rows: tables } = await client.query("SELECT to_regclass('trace.trace_events') AS name");
        const rows = tables[0].name ? (await client.query(`
            SELECT ts,kind,model,session_id,input_tokens,output_tokens,cached_tokens,cache_write_tokens,
                duration_ms,jsonb_build_object(
                    'provider',payload->'provider',
                    'uncached_input_tokens',payload->'uncached_input_tokens',
                    'response_id',payload->'response_id',
                    'service_tier',payload->'service_tier',
                    'sourceType',payload->'sourceType',
                    'source_type',payload->'source_type'
                ) AS payload
            FROM trace.trace_events WHERE kind='usage_raw' AND ts < $1 ORDER BY ts,id
        `, [until])).rows : [];
        await client.query('COMMIT');
        return rows;
    } finally { await client.end(); }
}
