#!/usr/bin/env node
// The `machine` tool (read-only machine state), as the patched Node answers it. What it reports is the machine's own (load, memory,
// disks, the process table), so the recording keeps the shape of every answer and not the values: each reading is written as a
// placeholder (`NORMALISATION` below, restated in the manifest). What stays exact is every line's wording, the order of the
// sections, the number of rows of a `top by …` list (the caller's `top`, clamped to 1-20, default 5), the "none" of an empty
// match list and the refusal texts. Rows whose number depends on the machine are collapsed to one: the drive rows, and the rows
// of a process-name match list (at most 25, then a "… N more" line).
//
//   node benchmarks/rust-core/recorders/record-machine-tool.mjs --tree <b6f10295a export with the patch> \
//     --patch benchmarks/rust-core/recorders/node-patches/node-change-shell-cover-tools.patch
//
// Output: native/core/fixtures/machine-tool/cases.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'machine-tool-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const BASE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
if (!args.get('patch')) throw new Error('record from the tree with the shell-cover-tools patch (--patch)');
const identity = nodeTreeIdentity(args, tree, BASE_COMMIT);
const importFrom = (rel) => import(pathToFileURL(join(tree, rel)).href);
const { executeBuiltinTool } = await importFrom('src/runtime/agent/orchestrator/tools/builtin.mjs');
const { classifyResultKind } = await importFrom('src/runtime/agent/orchestrator/session/result-classification.mjs');

const NORMALISATION = {
  cpu: '`cpu: N% busy of M cores (250 ms sample)` → `cpu: <n>% busy of <n> cores (250 ms sample)`',
  memory: '`memory: A GB available of T GB (P% used)` → `memory: <gb> GB available of <gb> GB (<n>% used)`',
  processRow: '`  NAME (pid P)  cpu C%  mem M MB` → `  <process> (pid <n>)  cpu <n>%  mem <n> MB`',
  driveRows: '`  ROOT  F GB of T GB` rows (any number) → one `  <drive> <gb> GB of <gb> GB`',
  matchRows: 'the process rows under `processes matching "X" (N):` (any number up to 25, then `  … K more`) → one `  <process rows>`; N → `<n>` unless 0',
  unavailable: 'a section Node reports as `unavailable (no answer within the deadline)` is a failed sample, not a shape: the recorder refuses to record one',
};

const PROCESS_ROW = /^ {2}\S.* \(pid \d+\) {2}cpu [\d.]+% {2}mem \d+ MB$/;
function normalise(text) {
  const out = [];
  let section = '';
  for (const line of text.split('\n')) {
    if (/^(cpu|memory|processes|drives|top by (?:cpu|memory))/.test(line) || /^processes matching /.test(line)) section = line.split(/[:(]/)[0].trim();
    let next = line;
    if (/^cpu: /.test(line)) next = line.replace(/^cpu: \d+% busy of \d+ cores/, 'cpu: <n>% busy of <n> cores');
    else if (/^memory: /.test(line)) next = line.replace(/^memory: [\d.]+ GB available of [\d.]+ GB \(\d+% used\)$/, 'memory: <gb> GB available of <gb> GB (<n>% used)');
    else if (section === 'drives' && /^ {2}\S/.test(line)) {
      if (out.at(-1) === '  <drive> <gb> GB of <gb> GB') continue;
      next = '  <drive> <gb> GB of <gb> GB';
    } else if (/^processes matching "/.test(line)) next = line.replace(/\((\d+)\):$/, (_, n) => (n === '0' ? '(0):' : '(<n>):'));
    else if (section.startsWith('processes matching')) {
      if (/^ {2}none$/.test(line)) next = line;
      else if (PROCESS_ROW.test(line) || /^ {2}… \d+ more$/.test(line)) {
        if (out.at(-1) === '  <process rows>') continue;
        next = '  <process rows>';
      }
    } else if (PROCESS_ROW.test(line)) next = '  <process> (pid <n>)  cpu <n>%  mem <n> MB';
    out.push(next);
  }
  return out.join('\n');
}

const cases = [
  { name: 'default', input: {} },
  { name: 'top 3', input: { top: 3 } },
  { name: 'top 1', input: { top: 1 } },
  { name: 'top 20', input: { top: 20 } },
  { name: 'top 21 is clamped', input: { top: 21 } },
  { name: 'top 0 is the default', input: { top: 0 } },
  { name: 'top -3 is clamped', input: { top: -3 } },
  { name: 'top as text is the default', input: { top: 'x' } },
  { name: 'top 2.7 is cut', input: { top: 2.7 } },
  { name: 'a name no process has', input: { process: 'no-such-process-name-zzz' } },
  { name: 'a name many processes have', input: { process: 'e', top: 2 } },
  { name: 'a blank name asks for no match list', input: { process: '   ' } },
  { name: 'an empty name asks for no match list', input: { process: '' } },
  { name: 'a name of 128 characters', input: { process: 'x'.repeat(128) } },
  { name: 'a name of 129 characters is refused', input: { process: 'x'.repeat(129) } },
  { name: 'a name with control characters is shown on one line', input: { process: 'no\nsuch\u001b[31m-name' } },
  { name: 'a name that is not text is ignored', input: { process: 42 } },
  { name: 'an unknown argument is ignored', input: { unknown: 1 } },
];

const results = [];
try {
  for (const c of cases) {
    const result = await executeBuiltinTool('machine', structuredClone(c.input), process.cwd());
    if (typeof result !== 'string') throw new Error(`${c.name}: a structured result was not expected`);
    if (/unavailable \(no answer within the deadline\)/.test(result)) throw new Error(`${c.name}: a sample missed its deadline; record again on a quieter machine`);
    results.push({ ...c, result: { text: normalise(result), isError: classifyResultKind(result, false, 'machine') === 'error' } });
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

const finalDir = join(FIXTURES_ROOT, 'machine-tool');
const stage = stageSet(finalDir);
writeJson(join(stage, 'cases.json'), {
  note: "Node's machine tool on the patched tree: arguments as handed to executeBuiltinTool('machine', args, cwd) and the normalised text it returned (see the manifest's exclusions).",
  platform: process.platform,
  normalisation: NORMALISATION,
  cases: results,
});
writeSetManifest(stage, {
  set: 'machine-tool',
  recorder: 'benchmarks/rust-core/recorders/record-machine-tool.mjs',
  command: `node benchmarks/rust-core/recorders/record-machine-tool.mjs --tree <tree> --patch ${identity.patch.file}`,
  identity,
  extra: { ...recorderProvenance(import.meta.url), exclusions: NORMALISATION },
});
commitStage(stage, finalDir);
console.log(`machine-tool: ${results.length} cases, ${results.filter((c) => c.result.isError).length} refused`);
