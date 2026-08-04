#!/usr/bin/env node
/**
 * session-sweep.mjs — DRY-RUN ONLY session-store retention reporter.
 *
 * Reports which session files a prune would reclaim WITHOUT touching disk:
 * NO unlink, NO writes to session-summaries.json, NO mutation of store.mjs
 * runtime behavior. It only reads.
 *
 * Reuses the real store helpers read-only:
 *   - getPluginData()  → resolves the live data dir (…/.mixdog/data)
 *   - summaryIndexPath()/listStoredSessionSummaries() → authoritative
 *     per-session lifecycle rows (updatedAt/closed/status), avoiding a full
 *     476MB JSON.parse of every session file.
 *
 * Candidate policy (conservative; keep everything else):
 *   - closed/tombstoned sessions  (row.closed === true || status === 'closed')
 *     ONLY when their closedAt/updatedAt is older than --min-closed-age-days
 *     (default 7d) — a recently-closed session may still be resumed, so it is
 *     kept until the gate elapses.
 *   - OR sessions older than --max-age-days by updatedAt (default 30d)
 * Thresholds are params:  --max-age-days=<n>  --min-closed-age-days=<n>  --now=<epochMs>
 *
 * This tool NEVER deletes. It only prints a report.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../src/runtime/agent/orchestrator/config.mjs';
import {
    summaryIndexPath,
    listStoredSessionSummaries,
} from '../src/runtime/agent/orchestrator/session/store.mjs';

// ── Cheap top-level-only scalar scan ────────────────────────────────────────
// Same depth-1 tokenizer idea as lifecycle-scan.mjs's scanTopLevelLifecycle
// (bracket-depth + string-escape aware; the whole `messages` array is skipped
// by depth counting, never parsed), extended to capture the lifecycle+age
// scalars we classify on (closed/status/updatedAt/createdAt). This lets the
// report read the AUTHORITATIVE per-file lifecycle without a full 476MB
// JSON.parse and without depending on the (stale) summary index.
const WANT = new Set(['closed', 'status', 'updatedAt', 'createdAt', 'closedAt']);
function isWs(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'; }
function skipString(raw, i) {
    const len = raw.length;
    i++;
    while (i < len) {
        const ch = raw[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '"') return i + 1;
        i++;
    }
    return i;
}
function skipValue(raw, i) {
    const len = raw.length;
    const c = raw[i];
    if (c === '"') return skipString(raw, i);
    if (c === '{' || c === '[') {
        let depth = 1; i++;
        while (i < len && depth > 0) {
            const ch = raw[i];
            if (ch === '"') { i = skipString(raw, i); continue; }
            if (ch === '{' || ch === '[') depth++;
            else if (ch === '}' || ch === ']') depth--;
            i++;
        }
        return i;
    }
    while (i < len && raw[i] !== ',' && raw[i] !== '}' && raw[i] !== ']' && !isWs(raw[i])) i++;
    return i;
}
function scanTopLevelScalars(raw) {
    const len = raw.length;
    let i = 0;
    while (i < len && isWs(raw[i])) i++;
    if (raw[i] !== '{') return null;
    i++;
    const out = {};
    while (i < len) {
        while (i < len && isWs(raw[i])) i++;
        if (i >= len) return out;
        if (raw[i] === '}') return out;
        if (raw[i] === ',') { i++; continue; }
        if (raw[i] !== '"') return out;
        const keyStart = i;
        i = skipString(raw, i);
        let key;
        try { key = JSON.parse(raw.slice(keyStart, i)); } catch { return out; }
        while (i < len && isWs(raw[i])) i++;
        if (raw[i] !== ':') return out;
        i++;
        while (i < len && isWs(raw[i])) i++;
        const valStart = i;
        i = skipValue(raw, i);
        if (WANT.has(key)) {
            try { out[key] = JSON.parse(raw.slice(valStart, i)); } catch { /* ignore */ }
        }
    }
    return out;
}

function parseArgs(argv) {
    const out = { maxAgeDays: 30, minClosedAgeDays: 7, now: Date.now() };
    for (const arg of argv) {
        const m = /^--([^=]+)=(.*)$/.exec(arg);
        if (!m) continue;
        const [, key, val] = m;
        if (key === 'max-age-days') out.maxAgeDays = Number(val);
        else if (key === 'min-closed-age-days') out.minClosedAgeDays = Number(val);
        else if (key === 'now') out.now = Number(val);
    }
    if (!Number.isFinite(out.maxAgeDays) || out.maxAgeDays < 0) out.maxAgeDays = 30;
    if (!Number.isFinite(out.minClosedAgeDays) || out.minClosedAgeDays < 0) out.minClosedAgeDays = 7;
    if (!Number.isFinite(out.now) || out.now <= 0) out.now = Date.now();
    return out;
}

function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function fmtTs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'n/a';
    try { return new Date(ms).toISOString(); } catch { return String(ms); }
}

function main() {
    const { maxAgeDays, minClosedAgeDays, now } = parseArgs(process.argv.slice(2));
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const minClosedAgeMs = minClosedAgeDays * 24 * 60 * 60 * 1000;

    const dir = join(getPluginData(), 'sessions');
    if (!existsSync(dir)) {
        process.stdout.write(`[session-sweep] no sessions dir at ${dir}\n`);
        return;
    }

    // Authoritative lifecycle rows (read-only). rebuildIfMissing:false so this
    // report never triggers a summary-index write.
    const rows = listStoredSessionSummaries({ rebuildIfMissing: false });
    const rowById = new Map();
    for (const r of rows) if (r?.id) rowById.set(r.id, r);

    // Disk scan for sizes + mtime fallback. `.hb` sidecar bytes are attributed
    // to their session so reclaimable bytes reflect the full on-disk footprint.
    const files = readdirSync(dir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const hbSizeById = new Map();
    for (const f of files) {
        if (!f.endsWith('.hb')) continue;
        const id = f.slice(0, -3);
        try { hbSizeById.set(id, statSync(join(dir, f)).size || 0); } catch { /* ignore */ }
    }

    let totalFiles = 0;
    let totalBytes = 0;
    const candidates = []; // { id, reason, updatedAt, bytes, inIndex }
    let closedCount = 0;
    let ageOnlyCount = 0;
    let closedBytes = 0;
    let ageOnlyBytes = 0;
    let reclaimBytes = 0;
    let scanFailFiles = 0;
    let closedButFreshCount = 0; // closed, but within the min-closed-age gate → kept
    let closedButFreshBytes = 0;
    const fileIds = new Set();

    for (const f of jsonFiles) {
        const id = f.slice(0, -5);
        fileIds.add(id);
        const full = join(dir, f);
        let size = 0;
        let mtimeMs = 0;
        try { const st = statSync(full); size = st.size || 0; mtimeMs = st.mtimeMs || 0; } catch { /* skip */ }
        const hb = hbSizeById.get(id) || 0;
        const bytes = size + hb;
        totalFiles += 1;
        totalBytes += bytes;

        const row = rowById.get(id) || null;
        // Authoritative per-file lifecycle via cheap top-level scan; the summary
        // index is stale here (most on-disk files are unindexed), so the file
        // itself — not the index — decides closed/age. Fall back to the index
        // row, then to file mtime, only when the scan can't resolve a field.
        let scan = null;
        try { scan = scanTopLevelScalars(readFileSync(full, 'utf-8')); } catch { scan = null; }
        if (!scan) scanFailFiles += 1;
        const closedScan = scan && (scan.closed === true || scan.status === 'closed');
        const closedRow = row && (row.closed === true || row.status === 'closed');
        const closed = scan ? !!closedScan : !!closedRow;
        let updatedAt = scan && Number(scan.updatedAt) > 0 ? Number(scan.updatedAt) : 0;
        if (!updatedAt && row && Number(row.updatedAt) > 0) updatedAt = Number(row.updatedAt);
        if (!updatedAt) updatedAt = mtimeMs;
        const ageMs = now - updatedAt;
        // Min-closed-age gate: a closed session only qualifies once its close
        // timestamp (closedAt when present, else updatedAt — markSessionClosed
        // sets updatedAt=Date.now() at tombstone time) is older than the gate.
        // Recently-closed sessions may still be resumed, so keep them.
        const closedAt = scan && Number(scan.closedAt) > 0 ? Number(scan.closedAt) : updatedAt;
        const closedAge = now - closedAt;
        const closedQualifies = closed
            && (minClosedAgeMs <= 0
                || (Number.isFinite(closedAt) && closedAt > 0 && closedAge > minClosedAgeMs));
        const ageOnly = !closed && maxAgeMs > 0 && Number.isFinite(updatedAt) && updatedAt > 0 && ageMs > maxAgeMs;

        if (closed && !closedQualifies) {
            closedButFreshCount += 1;
            closedButFreshBytes += bytes;
        }
        if (!closedQualifies && !ageOnly) continue; // keep

        const reason = closedQualifies ? 'closed' : 'age';
        candidates.push({ id, reason, updatedAt, bytes, inIndex: !!row });
        reclaimBytes += bytes;
        if (closedQualifies) { closedCount += 1; closedBytes += bytes; }
        else { ageOnlyCount += 1; ageOnlyBytes += bytes; }
    }

    candidates.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    const oldest = candidates[0] || null;
    const newest = candidates[candidates.length - 1] || null;
    const dropRows = candidates.filter((c) => c.inIndex).length;
    const remainFiles = totalFiles - candidates.length;
    // Rows in the index whose session file is already gone from disk — a
    // rebuild (scans existing files only) drops these regardless of retention.
    const staleRows = rows.filter((r) => r?.id && !fileIds.has(r.id)).length;
    // A real prune would delete candidate files then rebuild the index from the
    // surviving files, so the post-rebuild index equals the surviving-file count
    // (every remaining file gets a row, including currently-unindexed ones).
    const rebuiltIndexRows = remainFiles;

    const L = [];
    L.push('══ session-sweep DRY-RUN report (NO files deleted, NO writes) ══');
    L.push(`data dir            : ${dir}`);
    L.push(`summary index       : ${summaryIndexPath()} (${rows.length} rows)`);
    L.push(`now                 : ${fmtTs(now)}`);
    L.push(`retention (age)     : > ${maxAgeDays} days by updatedAt`);
    L.push(`retention (closed)  : (closed=true OR status='closed') AND closed > ${minClosedAgeDays}d ago`);
    L.push('');
    L.push(`total session files : ${totalFiles}  (${fmtBytes(totalBytes)})`);
    L.push(`candidates (drop)   : ${candidates.length}  (${fmtBytes(reclaimBytes)} reclaimable)`);
    L.push(`  ├─ closed         : ${closedCount}  (${fmtBytes(closedBytes)})`);
    L.push(`  └─ age-only >${maxAgeDays}d   : ${ageOnlyCount}  (${fmtBytes(ageOnlyBytes)})`);
    L.push(`kept: closed <${minClosedAgeDays}d : ${closedButFreshCount}  (${fmtBytes(closedButFreshBytes)}) — within min-closed-age gate`);
    L.push(`would remain        : ${remainFiles} files  (${fmtBytes(totalBytes - reclaimBytes)})`);
    L.push(`oldest candidate    : ${oldest ? `${oldest.id} @ ${fmtTs(oldest.updatedAt)} [${oldest.reason}]` : 'n/a'}`);
    L.push(`newest candidate    : ${newest ? `${newest.id} @ ${fmtTs(newest.updatedAt)} [${newest.reason}]` : 'n/a'}`);
    if (scanFailFiles > 0) L.push(`unparsable files    : ${scanFailFiles} (fell back to index/mtime)`);
    L.push('');
    L.push('── summary-index rebuild plan ──');
    L.push(`index rows total    : ${rows.length}`);
    L.push(`stale rows (no file): ${staleRows}  (already-deleted sessions; drop on rebuild)`);
    L.push(`candidate rows drop : ${dropRows}  (candidate files that also have an index row)`);
    L.push(`orphan candidates   : ${candidates.length - dropRows}  (candidate file present, no index row)`);
    L.push(`index rows after    : ${rebuiltIndexRows}  (= surviving files; rebuild reindexes all remaining)`);
    L.push('');
    L.push('DRY-RUN ONLY — this tool performed no unlink and no disk writes.');
    process.stdout.write(L.join('\n') + '\n');
}

main();
