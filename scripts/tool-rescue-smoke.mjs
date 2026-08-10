#!/usr/bin/env node
// Recoverable-failure smoke. Every case here is a shape taken from the local
// tool-failure journal (5-day window) that used to fail while the caller's
// intent was unambiguous. Each assertion states what the tool must now do —
// rescue it, or keep refusing when the intent is genuinely ambiguous.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { _isBenignSearchExitOne } from '../src/runtime/agent/orchestrator/tools/builtin/bash-tool.mjs';
import { hasPowerShellOnlySyntax } from '../src/runtime/agent/orchestrator/tools/builtin/shell-analysis.mjs';
import { planInlineScriptHoist } from '../src/runtime/agent/orchestrator/tools/builtin/shell-analysis.mjs';
import { resolveShellFor } from '../src/runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs';
import { executeCodeGraphTool } from '../src/runtime/agent/orchestrator/tools/code-graph.mjs';
import { normalizeCoreInput, normalizeCoreOp } from '../src/runtime/memory/lib/core-memory-store.mjs';
import { isLegitimateShellExit, classifyResultKind } from '../src/runtime/agent/orchestrator/session/result-classification.mjs';
import { normalizeToolEnvelope } from '../src/runtime/agent/orchestrator/session/tool-envelope.mjs';
import { routeWebFetchCall } from '../src/runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs';
import { buildNotFoundHint } from '../src/runtime/agent/orchestrator/tools/builtin/search-path-diagnostics.mjs';

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

// ── 5. Argument-synonym rescues observed on the other tools ─────────────────
check('memory core accepts op synonyms (logged 4x as op:"update")', () => {
  assert.equal(normalizeCoreOp('update'), 'edit');
  assert.equal(normalizeCoreOp('REMOVE'), 'delete');
  assert.equal(normalizeCoreOp('add'), 'add');
  assert.equal(normalizeCoreOp('promote'), 'promote');
  assert.equal(normalizeCoreOp('nonsense'), 'nonsense');
});

check('memory core accepts a summary written as text/content (logged 2x)', () => {
  const viaText = normalizeCoreInput({ text: 'Mixdog is project-scoped, never workspace-scoped' }, { requireElement: true, requireSummary: true });
  assert.deepEqual(viaText.errors, []);
  assert.equal(viaText.summary, 'Mixdog is project-scoped, never workspace-scoped');
  assert.equal(viaText.element.length, 40);
  assert.deepEqual(normalizeCoreInput({ content: 'x' }, { requireSummary: true }).errors, []);
  assert.equal(normalizeCoreInput({}, { requireSummary: true }).errors.length, 1);
});

check('web_fetch accepts a JSON-stringified url array (logged 1x)', () => {
  const call = { name: 'web_fetch', arguments: { url: '["https://a.example", "https://b.example"]' } };
  routeWebFetchCall(call);
  assert.deepEqual(call.arguments.url, ['https://a.example', 'https://b.example']);
  const single = { name: 'web_fetch', arguments: { url: 'https://a.example' } };
  routeWebFetchCall(single);
  assert.equal(single.arguments.url, 'https://a.example');
});

check('a drive path that lost its separators names the cause (logged 2x)', () => {
  assert.match(buildNotFoundHint(workspace, 'C:tmpsmp', 'Read'), /separator|escaping/i);
  assert.doesNotMatch(String(buildNotFoundHint(workspace, 'C:/tmp/smp', 'Read') || ''), /lost in escaping/i);
});

// ── 6. Completed non-zero commands are results, not tool failures ───────────
check('every completed non-zero process exit is a command result', () => {
  assert.equal(isLegitimateShellExit({ exitCode: 1, signal: null, stdout: '[probe] {"frames":121}\n', stderr: '' }), true);
  assert.equal(isLegitimateShellExit({ exitCode: 1, signal: null, stdout: 'ok\n', stderr: 'boom' }), true);
  assert.equal(isLegitimateShellExit({ exitCode: 2, signal: null, stdout: 'ok\n', stderr: '' }), true);
  assert.equal(isLegitimateShellExit({ exitCode: 127, signal: null, stdout: '', stderr: 'command not found' }), true);
  assert.equal(isLegitimateShellExit({ exitCode: 1, signal: null, stdout: '(no output)', stderr: '' }), true);
  assert.equal(isLegitimateShellExit({ exitCode: 1, signal: null, stdout: 'TAP version 13\nnot ok 1 - broken\n', stderr: '' }), true);
  assert.equal(isLegitimateShellExit({ exitCode: 1, signal: 'SIGKILL', stdout: 'ok\n', stderr: '' }), false);
  assert.equal(isLegitimateShellExit({ exitCode: 1, signal: null, timedOut: true }), false);
  assert.equal(classifyResultKind('[exit code: 7]\n\n(no output)'), 'normal');
});

check('live shell: a report-style exit 1 carries its code without an error banner', async () => {
  const script = "console.log(JSON.stringify({frames:3})); process.exit(1);";
  const raw = await executeBuiltinTool('shell', {
    command: `node -e "${script}"`,
    ...(isWindows ? { shell: 'bash' } : {}),
  }, workspace, {});
  const { result, explicitSuccess } = normalizeToolEnvelope(raw);
  const text = String(result);
  assert.ok(!isError(text), `report-style exit must not be framed as an error: ${text}`);
  assert.match(text, /\[exit code: 1\]/);
  assert.match(text, /\[completed: shell executed the command/);
  assert.match(text, /frames/);
  assert.equal(explicitSuccess, true, 'a legitimate exit must classify as normal');
  assert.equal(classifyResultKind(text, explicitSuccess), 'normal');
});

check('live shell: a test failure is returned as command data', async () => {
  const script = "console.log('TAP version 13'); console.log('not ok 1 - broken'); process.exit(1);";
  const raw = await executeBuiltinTool('shell', {
    command: `node -e "${script}"`,
    ...(isWindows ? { shell: 'bash' } : {}),
  }, workspace, {});
  const { result, explicitSuccess } = normalizeToolEnvelope(raw);
  const text = String(result);
  assert.ok(!isError(text), `a completed command must not be a tool error: ${text}`);
  assert.match(text, /\[exit code: 1\]/);
  assert.match(text, /not ok 1 - broken/);
  assert.equal(explicitSuccess, true);
});

// ── 7. Inline scripts run as files, so shell quoting cannot break them ──────
check('inline-script hoisting only fires where file semantics are identical', () => {
  const plain = planInlineScriptHoist('node -e "console.log(JSON.stringify({a:1}))"');
  assert.ok(plain, 'a quote-literal body must hoist');
  assert.equal(plain.extension, '.cjs');
  assert.match(plain.replace('C:/tmp/x.cjs'), /^node "C:\/tmp\/x\.cjs"$/);
  const esm = planInlineScriptHoist('node --input-type=module -e "await Promise.resolve()"');
  assert.equal(esm.extension, '.mjs');
  assert.doesNotMatch(esm.replace('C:/tmp/x.mjs'), /--input-type/);
  // Refusals: shell expansion, script-relative resolution, argv[1], python -c.
  assert.equal(planInlineScriptHoist('node -e "console.log($HOME)"'), null);
  assert.equal(planInlineScriptHoist('node -e "console.log(\\"x\\")"'), null);
  assert.equal(planInlineScriptHoist("node -e \"require('./local.js')\""), null);
  assert.equal(planInlineScriptHoist('node -e "console.log(import.meta.url)"'), null);
  assert.equal(planInlineScriptHoist('node -e "console.log(process.argv[1])"'), null);
  assert.equal(planInlineScriptHoist('node build.mjs'), null);
  assert.equal(planInlineScriptHoist('python -c "print(1)"').extension, '.py');
});

check('live shell: an inline script with nested quotes still runs', async () => {
  const out = await executeBuiltinTool('shell', {
    command: 'node -e "const o = {k: \'v\'}; console.log(JSON.stringify(o))"',
    ...(isWindows ? { shell: 'bash' } : {}),
  }, workspace, {});
  const text = String(out);
  assert.ok(!isError(text), text);
  assert.match(text, /\{"k":"v"\}/);
});

// ── 8. Default shell picks PowerShell 7 before Windows PowerShell 5.1 ───────
check('the default Windows shell prefers pwsh 7 over the bundled 5.1', () => {
  if (!isWindows) return 'skipped (POSIX host)';
  const spec = resolveShellFor('default');
  assert.equal(spec.shellType, 'powershell');
  const known = existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  if (!known) return 'skipped (pwsh 7 not installed)';
  assert.match(spec.shell, /pwsh\.exe$/i, `expected pwsh, got ${spec.shell}`);
  return null;
});

check('the default POSIX shell prefers Bash and supports Bash parameter expansion', async () => {
  if (isWindows) return 'skipped (Windows host)';
  const spec = resolveShellFor('default');
  assert.equal(spec.shellType, 'posix');
  const knownBash = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']
    .find((candidate) => existsSync(candidate));
  if (knownBash) assert.equal(spec.shell, knownBash);
  else if (spec.shell !== '/bin/sh') assert.match(spec.shell, /bash$/);
  const out = String(await executeBuiltinTool('shell', {
    command: 'value=abcdef; printf \'%s\\n\' "${value:0:3}"',
  }, workspace, {}));
  assert.ok(!isError(out), out);
  assert.match(out, /^abc\s*$/);
  return null;
});

check('a `&&` chain runs on the default shell (no 5.1 bashism block)', async () => {
  if (!isWindows) return 'skipped (POSIX host)';
  const out = String(await executeBuiltinTool('shell', { command: 'echo one && echo two' }, workspace, {}));
  assert.ok(!isError(out), out);
  assert.match(out, /one[\s\S]*two/);
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
