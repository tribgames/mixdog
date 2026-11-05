#!/usr/bin/env node
/**
 * Session-log dry run: proves the json → log migration on a COPY of a data
 * dir, never on the data dir itself.
 *
 *   node scripts/session-log-dryrun.mjs [--data-dir <dir>] [--json]
 *
 * The copy (`sessions/`, `session-summaries.*`, `session-catalog.sqlite*`)
 * lives in a scoped scratch dir that is removed at exit. Every source file is
 * hashed before the copy and again after the run: the report says whether the
 * source is byte-identical. On the copy it runs the startup migration, then
 * for every session compares the strict legacy load with the log replay,
 * appends a synthetic message and a header patch and compares again, and runs
 * one redaction rewrite (json, log and a set-aside copy) checking that the
 * value is in no file of that session afterwards. Exit status 1 when anything
 * differs, the source changed, or the redaction left the value behind.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { makeTempDirSync } from './lib/scoped-temp.mjs';

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const HASH_CONCURRENCY = 8;
const SYNTHETIC_MESSAGE = Object.freeze({ role: 'user', content: 'session-log dry run: synthetic message' });
const DEFAULT_DATA_DIR = join(process.env.USERPROFILE || process.env.HOME || '', '.mixdog', 'data');

async function pool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Absolute paths of everything the dry run reads: the sessions tree and the
 *  summary / catalog files beside it. */
async function sourceFiles(dataDir) {
  const files = [];
  const sessions = join(dataDir, 'sessions');
  for (const entry of await readdir(sessions, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
  }
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.startsWith('session-summaries.') || entry.name.startsWith('session-catalog.sqlite'))) {
      files.push(join(dataDir, entry.name));
    }
  }
  return files;
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Map of relative path → { size, mtimeMs, sha256 }. */
async function fingerprintSource(dataDir) {
  const files = await sourceFiles(dataDir);
  const entries = await pool(files, HASH_CONCURRENCY, async (path) => {
    const info = await stat(path);
    return [relative(dataDir, path), { size: info.size, mtimeMs: info.mtimeMs, sha256: await sha256File(path) }];
  });
  return new Map(entries);
}

function diffFingerprints(before, after) {
  const changed = [];
  for (const [name, a] of before) {
    const b = after.get(name);
    if (!b) changed.push({ file: name, change: 'removed' });
    else if (a.sha256 !== b.sha256 || a.size !== b.size) changed.push({ file: name, change: 'content' });
    else if (a.mtimeMs !== b.mtimeMs) changed.push({ file: name, change: 'mtime' });
  }
  for (const name of after.keys()) if (!before.has(name)) changed.push({ file: name, change: 'added' });
  return changed;
}

async function copySource(dataDir, copyDir) {
  // Links are copied as their targets: a preserved link would let the run's
  // migration, append and redaction write through it into the source.
  await cp(join(dataDir, 'sessions'), join(copyDir, 'sessions'), {
    recursive: true,
    preserveTimestamps: true,
    dereference: true,
  });
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.startsWith('session-summaries.') || entry.name.startsWith('session-catalog.sqlite'))) {
      await copyFile(join(dataDir, entry.name), join(copyDir, entry.name));
    }
  }
}

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null;
}

function latency(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted.at(-1) ?? null };
}

/** Where two JSON values first differ, for the report. */
function firstDifference(a, b, path = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const found = firstDifference(a[key], b[key], `${path}.${key}`);
      if (found) return found;
    }
  }
  return path;
}

async function statSize(path) {
  return (await stat(path)).size;
}

/**
 * Runs the dry run. `log(line)` receives progress lines. Returns the report;
 * `report.ok` is the exit verdict.
 */
export async function runSessionLogDryRun({ dataDir, log = () => {} }) {
  const startedAt = performance.now();
  const report = { dataDir, ok: false, phases: {} };
  const phase = async (name, work) => {
    const t0 = performance.now();
    const value = await work();
    report.phases[name] = Math.round(performance.now() - t0);
    log(`${name}: ${report.phases[name]} ms`);
    return value;
  };

  const before = await phase('hash-before', () => fingerprintSource(dataDir));
  const scratch = makeTempDirSync('session-log-dryrun');
  const copyDir = join(scratch, 'data');
  await mkdir(copyDir, { recursive: true });
  await phase('copy', () => copySource(dataDir, copyDir));
  // Everything below touches the copy only; the core resolves its data dir
  // from the environment, so it is pointed at the copy before it is imported.
  process.env.MIXDOG_DATA_DIR = copyDir;
  const storeDir = join(copyDir, 'sessions');

  const store = '../src/runtime/agent/orchestrator/session/store/';
  const { LEGACY_SESSION_LOADER } = await import(`${store}legacy-session.mjs`);
  // The store's own load of a record: its strict loader plus lifecycle defaults.
  const { _ensureLifecycleFields, _storedSessionFromText } = await import(`${store}serialize.mjs`);
  const { jsonEqual, SESSION_LOG_SUFFIX } = await import(`${store}session-log-format.mjs`);
  const { resolveSessionRecord } = await import(`${store}session-log-reader.mjs`);
  const { openSessionLog } = await import(`${store}session-log-writer.mjs`);
  const { migrateLegacySessions, readMigrationProgress, sessionLogMigrationProgressPath } = await import(
    `${store}session-log-migration.mjs`
  );
  const progressPath = sessionLogMigrationProgressPath(copyDir);
  const loadLegacy = (text, id) => _storedSessionFromText(id, text);

  const names = await readdir(storeDir);
  const ids = names
    .filter((name) => name.endsWith('.json') && SESSION_ID_RE.test(name.slice(0, -5)))
    .map((name) => name.slice(0, -5))
    .sort();
  const jsonOf = (id) => join(storeDir, `${id}.json`);
  const logOf = (id) => join(storeDir, `${id}${SESSION_LOG_SUFFIX}`);
  const claim = { assertHeld() {} };

  // The json files are only read by everything below except the redaction;
  // their hashes prove it for the migration and the compare passes.
  const jsonHashes = new Map(await pool(ids, HASH_CONCURRENCY, async (id) => [id, await sha256File(jsonOf(id))]));

  const migration = await phase('migrate', () =>
    migrateLegacySessions({
      storeDir,
      progressPath,
      loader: LEGACY_SESSION_LOADER,
      claimFor: () => ({ held: true, claim, release() {} }),
    })
  );
  const progress = await readMigrationProgress(progressPath);
  const jsonUntouched = (
    await pool(ids, HASH_CONCURRENCY, async (id) => (await sha256File(jsonOf(id))) === jsonHashes.get(id))
  ).every(Boolean);

  const result = {
    sessions: ids.length,
    equal: 0,
    different: [],
    skipped: {},
    skippedIds: {},
    appended: { equal: 0, different: [] },
  };
  const oldMs = [];
  const newMs = [];
  let jsonBytes = 0;
  let logBytes = 0;
  const logged = [];

  await phase('compare', async () => {
    for (const id of ids) {
      const skip = progress.skipped[id];
      const hasLog = await stat(logOf(id)).then(
        () => true,
        () => false
      );
      if (!hasLog) {
        const reason = skip?.reason ?? 'no-log';
        result.skipped[reason] = (result.skipped[reason] || 0) + 1;
        (result.skippedIds[reason] ??= []).push(id);
        continue;
      }
      jsonBytes += await statSize(jsonOf(id));
      logBytes += await statSize(logOf(id));

      const t0 = performance.now();
      const legacy = loadLegacy((await readFile(jsonOf(id))).toString('utf8'), id);
      const t1 = performance.now();
      const resolved = await resolveSessionRecord({ jsonPath: jsonOf(id), logPath: logOf(id), loadLegacy });
      const t2 = performance.now();
      oldMs.push(t1 - t0);
      newMs.push(t2 - t1);

      // A log record gets its lifecycle defaults on load, as the store does.
      const replayed = resolved.kind === 'log' ? _ensureLifecycleFields(resolved.session) : null;
      if (replayed && jsonEqual(legacy, replayed)) result.equal += 1;
      else {
        result.different.push({ id, kind: resolved.kind, at: replayed ? firstDifference(legacy, replayed) : null });
        continue;
      }
      logged.push(id);

      // The same session after one more message and one header change.
      const patch = { id, at: 'session-log-dryrun' };
      const recorder = await openSessionLog({ logPath: logOf(id), claim });
      await recorder.record({
        ...recorder.loaded,
        messages: [...recorder.loaded.messages, SYNTHETIC_MESSAGE],
        dryRunPatch: patch,
      });
      await recorder.close();
      const expected = { ...legacy, messages: [...legacy.messages, SYNTHETIC_MESSAGE], dryRunPatch: patch };
      const reloaded = await resolveSessionRecord({ jsonPath: jsonOf(id), logPath: logOf(id), loadLegacy });
      const reloadedSession = reloaded.kind === 'log' ? _ensureLifecycleFields(reloaded.session) : null;
      if (reloadedSession && jsonEqual(expected, reloadedSession)) result.appended.equal += 1;
      else {
        result.appended.different.push({
          id,
          kind: reloaded.kind,
          at: reloadedSession ? firstDifference(expected, reloadedSession) : null,
        });
      }
    }
  });

  // Redaction: the smallest compared session that has a plain token in a
  // message, and no other file than its json and log.
  const redaction = await phase('redaction', async () => {
    const filesById = new Map();
    for (const name of await readdir(storeDir)) {
      const id = name.slice(0, name.indexOf('.'));
      (filesById.get(id) ?? filesById.set(id, []).get(id)).push(name);
    }
    const plain = logged.filter((id) => filesById.get(id).length === 2);
    const bySize = await pool(plain, HASH_CONCURRENCY, async (id) => [id, await statSize(jsonOf(id))]);
    bySize.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    for (const [id] of bySize) {
      const legacy = loadLegacy((await readFile(jsonOf(id))).toString('utf8'), id);
      const text = legacy.messages.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n');
      // A token held by a message only: the log's header projection does not
      // redact header fields (reported by the redaction proof when one holds it).
      const header = JSON.stringify({ ...legacy, messages: undefined });
      const value = text.match(/[A-Za-z0-9]{12,}/g)?.find((token) => !header.includes(token));
      if (!value) continue;
      return redactSession({ id, value, legacy, storeDir, jsonOf, logOf, loadLegacy, jsonEqual, resolveSessionRecord, _ensureLifecycleFields });
    }
    return { ran: false, ok: false, reason: 'no compared session has a plain token to redact' };
  });

  const after = await phase('hash-after', () => fingerprintSource(dataDir));
  const sourceChanges = diffFingerprints(before, after);

  report.sourceFiles = before.size;
  report.sourceBytes = [...before.values()].reduce((sum, f) => sum + f.size, 0);
  report.sourceUntouched = sourceChanges.length === 0;
  report.sourceChanges = sourceChanges;
  report.migration = {
    total: migration.total,
    migrated: migration.migrated,
    converted: migration.converted,
    skipped: migration.skipped,
    complete: migration.complete,
    ms: migration.ms,
    jsonUntouchedOnCopy: jsonUntouched,
  };
  report.bytes = { json: jsonBytes, logAfterMigrationAndAppend: logBytes, logWrittenByMigration: migration.bytes };
  report.sessions = result;
  report.load = { oldMs: latency(oldMs), newMs: latency(newMs) };
  report.redaction = redaction;
  report.totalMs = Math.round(performance.now() - startedAt);
  report.ok =
    report.sourceUntouched &&
    jsonUntouched &&
    result.different.length === 0 &&
    result.appended.different.length === 0 &&
    redaction.ok === true;
  return report;
}

async function redactSession(ctx) {
  const { id, value, legacy, storeDir, jsonOf, logOf } = ctx;
  const store = '../src/runtime/agent/orchestrator/session/store/';
  const { rememberSensitiveValues, redactSensitiveText } = await import('../src/runtime/agent/orchestrator/session/sensitive-values.mjs');
  const { storedSessionAsync } = await import(`${store}stored-session.mjs`);
  const { recorderFor, redactSessionFiles } = await import(`${store}session-writers.mjs`);
  const { claimSessionWriterOrThrow, releaseSessionWriter } = await import(`${store}session-writer-claim.mjs`);
  // A diverged set-aside copy, named as the core names one (`.diverged-<n>-<hex>`).
  const asidePath = `${logOf(id)}.diverged-0-dec0de`;
  const filesOf = async () => (await readdir(storeDir)).filter((name) => name.startsWith(`${id}.`));
  const holders = async () => {
    const found = [];
    for (const name of await filesOf()) {
      if ((await readFile(join(storeDir, name))).includes(value)) found.push(name);
    }
    return found;
  };
  const redactDoc = (doc) => JSON.parse(redactSensitiveText(id, JSON.stringify(doc)));

  // A set-aside copy of the log, as a diverged rebase leaves one.
  await copyFile(logOf(id), asidePath);
  const present = await holders();
  const out = { ran: true, id, valueLength: value.length, heldBefore: present };

  // The production redaction, as a save of a session that gained a sensitive
  // value runs it: the value is registered the way a sensitive browser fill
  // registers it, then the writer's recorder redacts every file of the session.
  claimSessionWriterOrThrow(id);
  try {
    const session = await storedSessionAsync(storeDir, id);
    const recorder = recorderFor(session);
    rememberSensitiveValues(id, [
      { name: 'browser', arguments: { action: 'fill', input: { sensitive: true, text: value } } },
    ]);
    await redactSessionFiles(recorder, session);
  } finally {
    await releaseSessionWriter(id);
  }

  out.filesChecked = await filesOf();
  out.heldAfter = await holders();
  const resolved = await ctx.resolveSessionRecord({ jsonPath: jsonOf(id), logPath: logOf(id), loadLegacy: ctx.loadLegacy });
  out.kindAfter = resolved.kind;
  const replayed = resolved.kind === 'log' ? ctx._ensureLifecycleFields(resolved.session) : null;
  const expected = redactDoc({
    ...legacy,
    messages: [...legacy.messages, SYNTHETIC_MESSAGE],
    dryRunPatch: { id, at: 'session-log-dryrun' },
  });
  out.logEqualsRedactedExpectation = replayed !== null && ctx.jsonEqual(expected, replayed);
  out.ok =
    present.length === 3 &&
    out.heldAfter.length === 0 &&
    out.logEqualsRedactedExpectation &&
    out.filesChecked.every((name) => !name.endsWith('.tmp'));
  return out;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const ms = (value) => (value == null ? 'n/a' : `${value.toFixed(2)} ms`);

export function formatDryRunReport(report) {
  const { sessions: s, load, migration, bytes, redaction } = report;
  const lines = [
    `session-log dry run — ${report.dataDir}`,
    `source: ${report.sourceFiles} files, ${mb(report.sourceBytes)} · ${report.sourceUntouched ? 'UNTOUCHED (hashes equal before/after)' : `CHANGED: ${JSON.stringify(report.sourceChanges.slice(0, 20))}`}`,
    `migration: ${migration.migrated} migrated, ${migration.converted} already converted, skipped ${JSON.stringify(migration.skipped)}, complete=${migration.complete}, ${migration.ms} ms, json untouched on copy=${migration.jsonUntouchedOnCopy}`,
    `compare: ${s.equal} equal, ${s.different.length} different, skipped ${JSON.stringify(s.skipped)} (of ${s.sessions} sessions)`,
  ];
  for (const [reason, ids] of Object.entries(s.skippedIds)) lines.push(`  skipped ${reason}: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ` … +${ids.length - 10}` : ''}`);
  for (const d of s.different.slice(0, 10)) lines.push(`  different: ${d.id} kind=${d.kind} at ${d.at}`);
  lines.push(`append+patch: ${s.appended.equal} equal, ${s.appended.different.length} different`);
  for (const d of s.appended.different.slice(0, 10)) lines.push(`  different: ${d.id} kind=${d.kind} at ${d.at}`);
  lines.push(
    `bytes: json ${mb(bytes.json)} → log ${mb(bytes.logAfterMigrationAndAppend)} (migration wrote ${mb(bytes.logWrittenByMigration)})`,
    `load (n=${load.oldMs.n}): old p50 ${ms(load.oldMs.p50)} p99 ${ms(load.oldMs.p99)} max ${ms(load.oldMs.max)} · new p50 ${ms(load.newMs.p50)} p99 ${ms(load.newMs.p99)} max ${ms(load.newMs.max)}`,
    redaction.ran
      ? `redaction: ${redaction.id} (${redaction.valueLength}-char value) in ${redaction.heldBefore.length} files before, ${redaction.heldAfter.length} after of ${redaction.filesChecked.length}; log kind ${redaction.kindAfter}, matches redacted expectation=${redaction.logEqualsRedactedExpectation} → ${redaction.ok ? 'ok' : 'FAILED'}`
      : `redaction: not run (${redaction.reason})`,
    `phases (ms): ${JSON.stringify(report.phases)} · total ${report.totalMs} ms`,
    report.ok ? 'RESULT: ok' : 'RESULT: FAILED'
  );
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const dataDir = option('--data-dir') ?? process.env.MIXDOG_DATA_DIR ?? DEFAULT_DATA_DIR;
  const quiet = args.includes('--json');
  const report = await runSessionLogDryRun({ dataDir, log: (line) => (quiet ? null : console.error(line)) });
  console.log(quiet ? JSON.stringify(report, null, 2) : formatDryRunReport(report));
  process.exitCode = report.ok ? 0 : 1;
}
