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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function resolveReplaySnapshotPath(root, rel) {
  const text = String(rel || '');
  const portableAbsolute = /^[A-Za-z]:[\\/]/.test(text) || /^[/\\]{2}/.test(text);
  if (!text || text.includes('\0') || isAbsolute(text) || portableAbsolute
    || text.split(/[\\/]+/).includes('..')) {
    throw new Error(`unsafe snapshot path: ${text || '(empty)'}`);
  }
  const abs = resolve(root, text);
  const fromRoot = relative(root, abs);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`unsafe snapshot path: ${text}`);
  }
  return abs;
}

export function legacyPartialReplayReason(rec) {
  const partial = rec?.outcome?.kind === 'partial'
    || /apply_patch file-level partial/i.test(String(rec?.error_first_line || ''));
  if (partial && rec?.snapshot_phase !== 'pre') {
    return 'legacy partial capture has post-mutation snapshots; replay would not reproduce the original pre-state';
  }
  return null;
}

export async function replayOne(rec) {
  const skipReason = legacyPartialReplayReason(rec);
  if (skipReason) {
    return { id: rec.id, ok: false, skipped: true, skipReason, before: rec.error_first_line, after: null };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'mixdog-patch-replay-'));
  const previousCapture = process.env.MIXDOG_PATCH_REPLAY_CAPTURE;
  process.env.MIXDOG_PATCH_REPLAY_CAPTURE = '0';
  try {
    for (const [rel, content] of Object.entries(rec.file_snapshots || {})) {
      if (content == null) continue;
      let abs;
      try {
        abs = resolveReplaySnapshotPath(tmp, rel);
      } catch (error) {
        return {
          id: rec.id,
          ok: false,
          skipped: false,
          before: rec.error_first_line,
          after: `Error: ${error?.message || String(error)}`,
        };
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const args = { ...(rec.args || {}), base_path: tmp };
    let result;
    try { result = await executePatchTool('apply_patch', args, tmp, {}); }
    catch (e) { result = `Error: ${e?.message || String(e)}`; }
    return { id: rec.id, ok: !isErr(result), skipped: false, before: rec.error_first_line, after: String(result).split('\n')[0].slice(0, 200) };
  } finally {
    if (previousCapture === undefined) delete process.env.MIXDOG_PATCH_REPLAY_CAPTURE;
    else process.env.MIXDOG_PATCH_REPLAY_CAPTURE = previousCapture;
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const jsonMode = hasFlag('--json');
  const records = loadRecords();

  if (hasFlag('--list') || (!hasFlag('--replay-all') && !argValue('--replay'))) {
    if (jsonMode) { console.log(JSON.stringify(records.map(({ file_snapshots, args, ...m }) => m), null, 2)); return; }
    console.log(`captured apply_patch failures: ${records.length}  (dir: ${replayDir()})`);
    for (const r of records.slice(0, 50)) {
      const phase = r.snapshot_phase || 'legacy';
      console.log(`- ${r.id}  targets=${(r.targets || []).length}  phase=${phase}  ${new Date(r.ts).toISOString()}`);
      console.log(`    ${String(r.error_first_line || '').slice(0, 140)}`);
    }
    if (!records.length) console.log('(none - set MIXDOG_PATCH_REPLAY_CAPTURE=1 to capture)');
    return;
  }

  const one = argValue('--replay', null);
  const targets = one ? records.filter((r) => r.id === one || r.id.startsWith(one)) : records;
  if (!targets.length) {
    console.error(one ? `no replay matched: ${one}` : 'no captured failures');
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const rec of targets) results.push(await replayOne(rec));
  const passed = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.length - passed - skipped;

  if (jsonMode) {
    console.log(JSON.stringify({ total: results.length, passed, failed, skipped, results }, null, 2));
  } else {
    console.log(`patch-replay: ${passed} passed · ${failed} still fail · ${skipped} legacy-skipped`);
    for (const r of results) {
      console.log(`- ${r.id}: ${r.skipped ? 'legacy-skip' : r.ok ? 'PASS' : 'still fails'}`);
      if (r.skipped) console.log(`    skip: ${r.skipReason}`);
      else if (!r.ok) console.log(`    after: ${r.after}`);
    }
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}