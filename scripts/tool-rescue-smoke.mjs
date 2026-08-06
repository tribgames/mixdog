#!/usr/bin/env node
// Recoverable-failure smoke. Every case here is a shape taken from the local
// tool-failure journal (5-day window) that used to fail while the caller's
// intent was unambiguous. Each assertion states what the tool must now do —
// rescue it, or keep refusing when the intent is genuinely ambiguous.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { _isBenignSearchExitOne } from '../src/runtime/agent/orchestrator/tools/builtin/bash-tool.mjs';
import { hasPowerShellOnlySyntax } from '../src/runtime/agent/orchestrator/tools/builtin/shell-analysis.mjs';
import { executeCodeGraphTool } from '../src/runtime/agent/orchestrator/tools/code-graph.mjs';

const isWindows = process.platform === 'win32';
const workspace = mkdtempSync(join(tmpdir(), 'mixdog-rescue-smoke-'));
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
function isError(text) { return /^Error/i.test(String(text ?? '').trimStart()); }

writeFileSync(join(workspace, 'alpha.mjs'), 'export function helloRescue() {\n  return 1;\n}\n', 'utf8');
writeFileSync(join(workspace, 'beta.mjs'), 'import { helloRescue } from "./alpha.mjs";\nhelloRescue();\n', 'utf8');

// ── 1. Optional args carrying an explicit null / nested or padded arrays ────
check('grep tolerates glob:null (logged 4x)', async () => {
  const out = await executeBuiltinTool('grep', { pattern: 'helloRescue', path: workspace, glob: null }, workspace, {});
  assert.ok(!isError(out), out);
  assert.match(String(out), /alpha\.mjs/);
});

check('grep tolerates a nested path array (logged 1x)', async () => {
  const out = await executeBuiltinTool('grep', {
    pattern: ['helloRescue'],
    path: [[join(workspace, 'alpha.mjs'), join(workspace, 'beta.mjs')]],
  }, workspace, {});
  assert.ok(!isError(out), out);
});

check('grep tolerates null entries inside path[]', async () => {
  const out = await executeBuiltinTool('grep', {
    pattern: 'helloRescue',
    path: [join(workspace, 'alpha.mjs'), null],
  }, workspace, {});
  assert.ok(!isError(out), out);
});

check('grep without any pattern still refuses (intent is ambiguous)', async () => {
  const out = await executeBuiltinTool('grep', { path: workspace }, workspace, {});
  assert.ok(isError(out), `expected a refusal, got: ${out}`);
});

// ── 2. Benign search exit 1 inside a chain ──────────────────────────────────
check('a `;` / `&&` chain ending in a no-match search is not an error', () => {
  assert.equal(_isBenignSearchExitOne('cd /tmp && grep -c zzz a.txt', 1, null, ''), true);
  assert.equal(_isBenignSearchExitOne('echo hi; grep -c zzz a.txt', 1, null, ''), true);
  assert.equal(_isBenignSearchExitOne('grep -c zzz a.txt', 1, null, ''), true);
});

check('an ambiguous or non-search chain stays an error', () => {
  assert.equal(_isBenignSearchExitOne('grep -c zzz a.txt || echo none', 1, null, ''), false);
  assert.equal(_isBenignSearchExitOne('grep -c zzz a.txt; npm test', 1, null, ''), false);
  assert.equal(_isBenignSearchExitOne('echo hi; grep -c zzz a.txt', 1, null, 'boom'), false);
  assert.equal(_isBenignSearchExitOne('echo hi; grep -c zzz a.txt', 2, null, ''), false);
});

check('live shell: chained no-match search returns output without an error banner', async () => {
  const command = isWindows
    ? `cd "${workspace.replace(/\\/g, '/')}" && grep -c zzz alpha.mjs`
    : `cd "${workspace}" && grep -c zzz alpha.mjs`;
  const out = await executeBuiltinTool('shell', { command, ...(isWindows ? { shell: 'bash' } : {}) }, workspace, {});
  assert.ok(!isError(out), `no-match search inside a chain must not be an error: ${out}`);
});

// ── 3. Bash-only command on a PowerShell host ───────────────────────────────
check('PowerShell-only syntax detector separates the rescuable commands', () => {
  assert.equal(hasPowerShellOnlySyntax('git log --oneline -5; git status --short | head -20'), false);
  assert.equal(hasPowerShellOnlySyntax('grep -rl needle src'), false);
  assert.equal(hasPowerShellOnlySyntax('grep -rl needle src 2>$null'), true);
  assert.equal(hasPowerShellOnlySyntax("$py='C:/py.exe'; & $py -c 'print(1)' | grep 1"), true);
  assert.equal(hasPowerShellOnlySyntax('Get-Content log.txt | grep error'), true);
});

check('a pure-bash command blocked by the PowerShell preflight now runs in bash', async () => {
  if (!isWindows) return 'skipped (POSIX host)';
  const out = await executeBuiltinTool('shell', { command: 'echo rescue-ok | head -1' }, workspace, {});
  assert.ok(!isError(out), out);
  assert.match(String(out), /rescue-ok/);
  assert.match(String(out), /Git Bash/);
  return null;
});

check('a mixed PowerShell/bash command stays blocked', async () => {
  if (!isWindows) return 'skipped (POSIX host)';
  const out = await executeBuiltinTool('shell', { command: 'Get-ChildItem | grep alpha' }, workspace, {});
  assert.ok(isError(out), `expected a preflight block, got: ${out}`);
  assert.match(String(out), /preflight blocked/i);
  return null;
});

// ── 4. code_graph on a sentinel-free single tree with a "." anchor ──────────
check('code_graph accepts files:"." on a sentinel-free tree (logged 35x)', async () => {
  const out = await executeCodeGraphTool('code_graph', {
    mode: 'symbol_search', files: '.', symbols: ['helloRescue'], limit: 10,
  }, workspace, null, {});
  assert.doesNotMatch(String(out), /is not inside a project/, String(out));
});

check('code_graph never indexes the home directory itself', async () => {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return 'skipped (no home dir)';
  let text = '';
  try {
    text = String(await executeCodeGraphTool('code_graph', { mode: 'symbol_search', files: '.', symbols: ['zzzz-unlikely-symbol'] }, home, null, {}));
  } catch (err) { text = String(err?.message || err); }
  // Either a refusal, or federation into already-trusted project roots under
  // home — never an index of the home tree itself.
  const indexedHome = text.toLowerCase().includes(`cwd=${home.toLowerCase()})`);
  assert.ok(/is not inside a project|Refusing to index/i.test(text) || !indexedHome, text);
  return null;
});

let failed = 0;
try {
  for (const { name, fn } of checks) {
    try {
      const note = await fn();
      console.log(`  ok   ${name}${note ? ` — ${note}` : ''}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${name}\n       ${String(err?.message || err).split('\n').slice(0, 4).join('\n       ')}`);
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
console.log(failed === 0
  ? `tool rescue smoke passed (${checks.length} cases)`
  : `tool rescue smoke FAILED: ${failed}/${checks.length}`);
process.exit(failed === 0 ? 0 : 1);
