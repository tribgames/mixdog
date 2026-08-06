#!/usr/bin/env node
// Replays apply_patch failures against the CURRENT engine.
//
// Two sources, one harness:
//   1. The in-repo corpus (scripts/fixtures/patch-replay-corpus.json) — one
//      entry per failure SHAPE observed in the local failure journals, each
//      with an asserted outcome. This half is deterministic and gates the
//      smoke's exit code.
//   2. The machine's patch-replay journal, when present: every rejected patch
//      is recorded with its exact args plus the on-disk content of each target
//      at failure time, so a replay reproduces the original conditions
//      byte-for-byte. Report-only (plus a crash cap), since its contents vary
//      per machine.
//
// Usage:
//   node scripts/apply-patch-replay-smoke.mjs [--dir <journal dir>] [--json]
//     [--limit N] [--require-applied <id,id>] [--max-crashes N] [--no-journal]
//
// Default journal dir: $MIXDOG_HOME/data/history/patch-replays (~/.mixdog/…).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

const jsonMode = process.argv.includes('--json');
const skipJournal = process.argv.includes('--no-journal');
const limit = Math.max(1, Number.parseInt(argValue('--limit', '200'), 10) || 200);
const maxCrashes = Math.max(0, Number.parseInt(argValue('--max-crashes', '0'), 10) || 0);
const requireApplied = String(argValue('--require-applied', '') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const mixdogHome = process.env.MIXDOG_HOME || resolve(homedir(), '.mixdog');
const journalDir = argValue('--dir', resolve(mixdogHome, 'data', 'history', 'patch-replays'));
const corpusFile = argValue('--corpus', new URL('./fixtures/patch-replay-corpus.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function loadRecords(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .map((file) => {
      try {
        const record = JSON.parse(readFileSync(file, 'utf8'));
        return record && typeof record === 'object' ? { file, ...record } : null;
      } catch { return null; }
    })
    .filter(Boolean)
    .filter((record) => record.tool === 'apply_patch' && record.args && record.file_snapshots);
}

// A replay must never write outside its throwaway workspace: refuse absolute
// or parent-escaping snapshot keys instead of materialising them.
function safeJoin(root, relative) {
  const full = resolve(root, relative);
  const rootResolved = resolve(root);
  return full === rootResolved || full.startsWith(`${rootResolved}\\`) || full.startsWith(`${rootResolved}/`)
    ? full
    : null;
}

function classifyOutcome(text) {
  const body = String(text ?? '');
  if (!/^Error/i.test(body.trimStart())) return { outcome: 'applied', reason: '' };
  const head = body.split('\n')[0].trim();
  if (/must be of type|is not a function|undefined is not|Cannot read/i.test(head)) {
    return { outcome: 'crash', reason: head };
  }
  if (/compacted-history placeholder/i.test(head)) return { outcome: 'rejected/placeholder', reason: head };
  if (/context not found|hunk rejected|stale/i.test(body)) return { outcome: 'rejected/context', reason: head };
  if (/already exists|ENOENT|no such file|unreadable/i.test(body)) return { outcome: 'rejected/path', reason: head };
  return { outcome: 'rejected/other', reason: head };
}

async function replay(record) {
  const workspace = mkdtempSync(join(tmpdir(), 'mixdog-patch-replay-'));
  try {
    for (const [relative, content] of Object.entries(record.file_snapshots || {})) {
      const full = safeJoin(workspace, relative);
      if (!full || typeof content !== 'string') continue;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    const args = { ...record.args };
    // The journal keeps the original absolute base_path; the replay is
    // relative to its own workspace.
    delete args.base_path;
    for (const key of Object.keys(args)) if (args[key] === null) delete args[key];
    const text = String(await executePatchTool('apply_patch', args, workspace, {}));
    const outcome = { ...classifyOutcome(text), text };
    // Corpus entries may assert the resulting file content, so read it back
    // before the workspace is discarded.
    if (record.expect_content) {
      outcome.content = {};
      for (const relative of Object.keys(record.expect_content)) {
        const full = safeJoin(workspace, relative);
        outcome.content[relative] = full && existsSync(full) ? readFileSync(full, 'utf8') : null;
      }
    }
    return outcome;
  } catch (err) {
    return { outcome: 'crash', reason: err?.message || String(err), text: String(err?.stack || err) };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// ── 1. In-repo corpus: asserted outcomes ────────────────────────────────────
const corpus = existsSync(corpusFile) ? JSON.parse(readFileSync(corpusFile, 'utf8')) : [];
const corpusResults = [];
for (const record of corpus) {
  const outcome = await replay(record);
  const wantApplied = String(record.expect || 'applied') === 'applied';
  const problems = [];
  if (outcome.outcome === 'crash') problems.push(`crashed: ${outcome.reason}`);
  else if (wantApplied && outcome.outcome !== 'applied') problems.push(`expected applied, got ${outcome.outcome}: ${outcome.reason}`);
  else if (!wantApplied && outcome.outcome === 'applied') problems.push('expected a rejection, but the patch applied');
  if (!wantApplied && record.expect_error && outcome.outcome !== 'applied'
    && !new RegExp(record.expect_error, 'i').test(outcome.text || '')) {
    problems.push(`error text does not match /${record.expect_error}/: ${outcome.reason}`);
  }
  for (const [relative, expected] of Object.entries(record.expect_content || {})) {
    const actual = outcome.content?.[relative];
    if (actual !== expected) problems.push(`${relative} content mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
  corpusResults.push({ id: record.id, note: record.note, outcome: outcome.outcome, problems });
}

const corpusFailures = corpusResults.filter((row) => row.problems.length > 0);
if (!jsonMode) {
  console.log(`apply_patch replay smoke — corpus: ${corpusResults.length} observed failure shape(s)`);
  for (const row of corpusResults) {
    console.log(`  ${row.problems.length ? 'FAIL' : 'ok  '} ${row.outcome.padEnd(20)} ${row.id}`);
    for (const problem of row.problems) console.log(`       ${problem}`);
  }
}

// ── 2. Machine journal: report-only replay ──────────────────────────────────
const records = loadRecords(journalDir).slice(-limit);
if (skipJournal || records.length === 0) {
  if (!jsonMode) {
    console.log(skipJournal
      ? 'journal replay skipped (--no-journal)'
      : `journal replay skipped: no records in ${journalDir}`);
  }
  if (jsonMode) console.log(JSON.stringify({ corpusFile, corpus: corpusResults }, null, 2));
  process.exit(corpusFailures.length ? 1 : 0);
}

const results = [];
for (const record of records) {
  const outcome = await replay(record);
  results.push({
    id: record.id,
    ts: record.ts,
    targets: (record.targets || []).join(', '),
    before: String(record.error_first_line || '').slice(0, 120),
    ...outcome,
  });
}

const counts = new Map();
for (const row of results) counts.set(row.outcome, (counts.get(row.outcome) || 0) + 1);
const crashes = results.filter((row) => row.outcome === 'crash');
const applied = results.filter((row) => row.outcome === 'applied');

if (jsonMode) {
  console.log(JSON.stringify({ corpusFile, corpus: corpusResults, journalDir, total: results.length, counts: [...counts], results }, null, 2));
} else {
  console.log(`apply_patch replay smoke — ${results.length} journalled failure(s) from ${journalDir}`);
  for (const row of results) {
    const when = Number.isFinite(row.ts) ? new Date(row.ts).toISOString().slice(0, 19) : '-';
    console.log(`  ${row.outcome.padEnd(20)} ${when}  ${row.id}  ${row.targets}`);
    if (row.outcome === 'crash') console.log(`      then: ${row.before}\n      now : ${row.reason}`);
  }
  console.log('---');
  console.log(`now applied: ${applied.length}/${results.length}`);
  for (const [outcome, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${outcome}: ${count}`);
}

let failed = corpusFailures.length > 0;
if (failed) console.error(`replay smoke FAILED: ${corpusFailures.length} corpus expectation(s) unmet`);
if (crashes.length > maxCrashes) {
  console.error(`replay smoke FAILED: ${crashes.length} crash-shaped result(s) (cap ${maxCrashes})`);
  failed = true;
}
for (const id of requireApplied) {
  const row = results.find((entry) => entry.id === id);
  if (!row) {
    console.error(`replay smoke FAILED: required record ${id} is not in the journal`);
    failed = true;
  } else if (row.outcome !== 'applied') {
    console.error(`replay smoke FAILED: ${id} still ${row.outcome} — ${row.reason}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
