#!/usr/bin/env node
// patch-replay.mjs — re-run captured apply_patch FAILURES against current code.
// Failures frozen by patch.mjs (MIXDOG_PATCH_REPLAY_CAPTURE=1) into
// <data>/history/patch-replays/*.json with original args + target file snapshots.
// Replays into a throwaway temp copy (never touches the repo) and reports pass/fail.
//   node scripts/patch-replay.mjs --list
//   node scripts/patch-replay.mjs --replay <id>
//   node scripts/patch-replay.mjs --replay-all [--json]
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
function hasFlag(name) { return process.argv.includes(name); }

function replayDir() {
  if (process.env.MIXDOG_PATCH_REPLAY_DIR) return resolve(process.env.MIXDOG_PATCH_REPLAY_DIR);
  const data = process.env.MIXDOG_DATA_DIR || resolve(homedir(), '.mixdog', 'data');
  return resolve(data, 'history', 'patch-replays');
}

function loadRecords() {
  const dir = replayDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return { file: join(dir, f), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }; }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
}

function isErr(text) { return /^Error[\s:[]/.test(String(text || '').trimStart()); }

async function replayOne(rec) {
  const tmp = mkdtempSync(join(tmpdir(), 'mixdog-patch-replay-'));
  try {
    for (const [rel, content] of Object.entries(rec.file_snapshots || {})) {
      if (content == null) continue;
      const abs = join(tmp, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const args = { ...(rec.args || {}), base_path: tmp };
    let result;
    try { result = await executePatchTool('apply_patch', args, tmp, {}); }
    catch (e) { result = `Error: ${e?.message || String(e)}`; }
    return { id: rec.id, ok: !isErr(result), before: rec.error_first_line, after: String(result).split('\n')[0].slice(0, 200) };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

const jsonMode = hasFlag('--json');
const records = loadRecords();

if (hasFlag('--list') || (!hasFlag('--replay-all') && !argValue('--replay'))) {
  if (jsonMode) { console.log(JSON.stringify(records.map(({ file_snapshots, args, ...m }) => m), null, 2)); process.exit(0); }
  console.log(`captured apply_patch failures: ${records.length}  (dir: ${replayDir()})`);
  for (const r of records.slice(0, 50)) {
    console.log(`- ${r.id}  targets=${(r.targets || []).length}  ${new Date(r.ts).toISOString()}`);
    console.log(`    ${String(r.error_first_line || '').slice(0, 140)}`);
  }
  if (!records.length) console.log('(none - set MIXDOG_PATCH_REPLAY_CAPTURE=1 to capture)');
  process.exit(0);
}

const one = argValue('--replay', null);
const targets = one ? records.filter((r) => r.id === one || r.id.startsWith(one)) : records;
if (!targets.length) { console.error(one ? `no replay matched: ${one}` : 'no captured failures'); process.exit(1); }

const results = [];
for (const rec of targets) results.push(await replayOne(rec));
const passed = results.filter((r) => r.ok).length;

if (jsonMode) {
  console.log(JSON.stringify({ total: results.length, passed, failed: results.length - passed, results }, null, 2));
} else {
  console.log(`patch-replay: ${passed}/${results.length} now succeed`);
  for (const r of results) {
    console.log(`- ${r.id}: ${r.ok ? 'PASS' : 'still fails'}`);
    if (!r.ok) console.log(`    after: ${r.after}`);
  }
}
process.exitCode = passed === results.length ? 0 : 1;