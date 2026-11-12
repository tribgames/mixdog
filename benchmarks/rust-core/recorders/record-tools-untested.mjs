#!/usr/bin/env node
// What Node's tool helpers answer in the cases its own tests assert and the Rust core had no test for
// (gaps-tools.md section 3): the real functions of the exact export of b6f10295a, called with the literal inputs of
// those tests (and the neighbours of each that decide the same behaviour), whole answers kept in call order.
// One JSON per Rust module under native/core/fixtures/tools-untested/.
//
//   node benchmarks/rust-core/recorders/record-tools-untested.mjs --tree <exact export of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-tools-untested.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const sandbox = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-tools-untested-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[name] = join(sandbox, name.toLowerCase());
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(sandbox, 'failures.jsonl');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';

const orch = 'src/runtime/agent/orchestrator';
const bt = `${orch}/tools/builtin`;
const load = (rel) => importFrom(tree, rel);
const sets = {};
const notes = {};

// ---- exec: benign exit one (scripts/shellhardening/exit-classification.test.mjs :5, integration.live.test.mjs :5, :37) ----
{
  const { _isBenignSearchExitOne } = await load(`${bt}/bash-tool/benign-exit.mjs`);
  const commands = [
    // BENIGN and NOT_BENIGN of scripts/shellhardening/_shared.mjs
    'grep x | sls', 'Select-String foo', 'git diff --quiet', 'git -C . diff --exit-code', 'grep -n foo file', 'findstr foo file.txt',
    'git diff --check', 'git grep -n foo', 'git -C . grep foo',
    'grep x file && echo done', '... < <(printf x | grep y)', 'echo hi `| Select-String x`', 'git diff-index --quiet', 'git diff',
    // the exit-code, quiet and a global option before the subcommand (integration.live.test.mjs :37)
    'git diff --exit-code', 'git --no-pager diff --quiet', 'git -c core.pager=cat diff --check', 'git --git-dir=x diff --exit-code', 'git diff HEAD~1 -- a.txt', 'git status',
    'node -e "process.exit(1); grep"',
    'Get-Content a.txt | Select-String nomatch', 'C:\\bin\\Grep.EXE x f', 'grep x f || true', "grep 'x f", 'echo $(grep x f)',
  ];
  const calls = [
    ...commands.map((command) => ({ command, exitCode: 1, signal: null, stderr: '' })),
    { command: 'grep x file', exitCode: 2, signal: null, stderr: '' },
    { command: 'grep x file', exitCode: 1, signal: null, stderr: 'grep: file: No such file' },
    { command: 'grep x file', exitCode: 1, signal: 'SIGTERM', stderr: '' },
    { command: 'grep x file', exitCode: 1, signal: null, stderr: '  \n' },
    { command: 'grep x file', exitCode: 0, signal: null, stderr: '' },
  ];
  sets['exec-benign'] = { calls: calls.map((c) => ({ ...c, benign: _isBenignSearchExitOne(c.command, c.exitCode, c.signal, c.stderr) })) };
}

// ---- exec: the shell hold and run limit (bash-tool/deadline-plan.test.mjs) ----
{
  const { planShellDeadlines } = await load(`${bt}/bash-tool/deadline-plan.mjs`);
  const envs = [{}, { MIXDOG_SHELL_AUTO_BACKGROUND_MS: '20000' }, { MIXDOG_SHELL_AUTO_BACKGROUND_MS: '0' }, { MIXDOG_SHELL_AUTO_BACKGROUND_MS: ' ' }, { MIXDOG_SHELL_AUTO_BACKGROUND_MS: '-5' }, { MIXDOG_SHELL_AUTO_BACKGROUND_MS: 'abc' }, { BASH_MAX_TIMEOUT_MS: '200000' }, { BASH_MAX_TIMEOUT_MS: '0' }];
  const argSets = [
    {}, { wait_ms: 20_000 }, { wait_ms: 5_000 }, { wait_ms: 300_000 }, { wait_ms: 5_000_000 }, { wait_ms: 10 }, { wait_ms: 45_000 },
    { timeout_ms: 4000 }, { timeout_ms: 300_000 }, { timeout_ms: 60_000 }, { timeout_ms: 5_000_000_000 }, { timeout_ms: 300_000, wait_ms: 90_000 },
    { background: true }, { background: true, wait_ms: 90_000 }, { background: true, timeout_ms: 4000 },
  ];
  const calls = [];
  for (const env of envs) {
    for (const input of argSets) {
      for (const backgroundOnTimeout of [true, false]) {
        const saved = {};
        for (const name of ['MIXDOG_SHELL_AUTO_BACKGROUND_MS', 'BASH_MAX_TIMEOUT_MS', 'MIXDOG_SHELL_BACKGROUND_MAX_MS']) { saved[name] = process.env[name]; delete process.env[name]; }
        Object.assign(process.env, env);
        const plan = planShellDeadlines({ args: input, backgroundOnTimeout });
        for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        calls.push({ env, args: input, backgroundOnTimeout, plan });
      }
    }
  }
  sets['exec-deadline'] = { calls };
}

// ---- exec: oversized commands move to a file (script-transport.slow.test.mjs) ----
{
  const { planLongInlineScriptFileTransport, planLongShellScriptFileTransport } = await load(`${bt}/shell-analysis.mjs`);
  const body = (n) => `const slash = "\\\\"; /*${'x'.repeat(n)}*/ console.log("ok")`;
  const longPs = `$value = 1\n${'# padding\n'.repeat(3000)}Write-Output $value`;
  const inline = [
    [`node -e '${body(25_000)}'`, 'win32', 'powershell'],
    [`node -e '${body(25_000)}'`, 'win32', 'posix'],
    [`node -e '${body(25_000)}'`.slice(0, 1_000), 'win32', 'powershell'],
    [`node -e '${body(25_000)}'`, 'linux', 'posix'],
    [`node -e '${body(35_000)}'`, 'win32', 'powershell'],
    [`# ${'패딩'.repeat(9000)}\nWrite-Output '장문-전송-정상'`, 'win32', 'powershell'],
    [`python -c '${'y'.repeat(20_000)}'`, 'win32', 'powershell'],
  ];
  const script = [
    [longPs, 'win32', 'powershell'],
    [`${longPs}\nWrite-Output $PSScriptRoot`, 'win32', 'powershell'],
    [`# ${'패딩'.repeat(9000)}\nWrite-Output '장문-전송-정상'`, 'win32', 'powershell'],
    [longPs, 'win32', 'posix'],
    [longPs, 'linux', 'powershell'],
    [longPs.slice(0, 500), 'win32', 'powershell'],
  ];
  const planned = (fn, [command, platform, shellType]) => {
    const plan = fn(command, { platform, shellType });
    return { command, platform, shellType, plan: plan && { command: plan.command === command ? '<SAME>' : plan.command, extension: plan.extension, body: plan.body === command ? '<COMMAND>' : plan.body, replaced: plan.replace("C:\\Temp\\it's-long-command.cjs") } };
  };
  sets['exec-hoist-long'] = { pathGiven: "C:\\Temp\\it's-long-command.cjs", inline: inline.map((c) => planned(planLongInlineScriptFileTransport, c)), script: script.map((c) => planned(planLongShellScriptFileTransport, c)) };
}

// ---- exec: the environment a shell child gets (bash-tool-cwd-env.test.mjs) ----
{
  const { buildShellSpawnEnv } = await load(`${bt}/bash-tool/spawn-env.mjs`);
  const { skillLauncherDir, skillScriptRuntime } = await load('src/runtime/shared/skill-script-runtime.mjs');
  const dataDir = process.env.MIXDOG_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });
  const launcher = skillLauncherDir(skillScriptRuntime(), dataDir);
  const cases = [
    { cwd: 'C:\\Project\\mixdog', base: { PATH: ['A', 'B'].join(delimiter), MIXDOG_SESSION_CWD: 'C:\\wrong-session' } },
    { cwd: 'C:\\x', base: { PATH: ['A', 'B'].join(delimiter) } },
    { cwd: 'C:\\x', base: { PATH: [launcher, 'A'].join(delimiter) } },
    { cwd: 'C:\\x', base: { PATH: ['A', '', 'B'].join(delimiter) } },
    { cwd: 'C:\\x', base: {} },
  ];
  const scrub = (text) => String(text).replaceAll(launcher, '<LAUNCHER>');
  sets['exec-env'] = {
    platform: process.platform,
    cases: cases.map((c) => {
      const env = buildShellSpawnEnv(c.cwd, { ...c.base });
      return { cwd: c.cwd, base: { ...c.base, ...(c.base.PATH === undefined ? {} : { PATH: scrub(c.base.PATH) }) }, PATH: env.PATH === undefined ? null : scrub(env.PATH), MIXDOG_SESSION_CWD: env.MIXDOG_SESSION_CWD ?? null };
    }),
  };
}

// ---- fs: markers (shared/tool-output-marker.test.mjs) ----
{
  const { capMarker, formatCapSize, windowMarker } = await load('src/runtime/shared/tool-output-marker.mjs');
  sets['fs-markers'] = {
    sizes: [0, 1, 1023, 1024, 1536, 5 * 1024, 5 * 1024 + 100, 1024 * 1024, 50 * 1024].map((bytes) => ({ bytes, text: formatCapSize(bytes) })),
    windows: [
      { from: 5, to: 27, total: 90, nextOffset: 28 }, { from: 5, to: 90, total: 90 }, { unit: 'chars', from: 0, to: 10, total: 30, nextOffset: 10 },
      { from: 1, to: 5, total: 20, nextOffset: 6, capBytes: 512 }, { from: 1, to: 5, nextOffset: 6 }, { from: 1, to: 5, capBytes: 51200 },
    ].map((input) => ({ input, text: windowMarker(input) })),
    caps: [
      { limit: 5 * 1024, shown: '63 match row(s) shown', nextOffset: 63 }, { limit: 1024 }, { limit: 1536, narrow: 'narrow the path' },
      { limit: '500 rows', narrow: 'narrow the path' }, { limit: 100, shown: 'a' }, { limit: '500 rows', shown: 'x', nextOffset: 7, narrow: 'n' },
    ].map((input) => ({ input, text: capMarker(input) })),
    notPortedFromNode: 'capMarker\'s cursor and fullPath, windowMarker\'s offsetKey: the Rust markers have no caller that passes them',
  };
}

// ---- fs: shell output cap and text statistics (shell-output-bytes.test.mjs, text-stats.test.mjs) ----
{
  const { capShellOutput, SMART_BASH_MAX_BYTES } = await load(`${bt}/shell-output.mjs`);
  const lines = (n, width) => Array.from({ length: n }, (_, i) => `line-${i}`.padEnd(width, '.')).join('\n');
  const inputs = [
    '가'.repeat(Math.floor(SMART_BASH_MAX_BYTES / 2)), 'short output', '', lines(400, 5), lines(401, 5), lines(1000, 20), lines(30, 3000), 'x'.repeat(SMART_BASH_MAX_BYTES),
    'x'.repeat(SMART_BASH_MAX_BYTES + 1), `${'한'.repeat(1000)}\n${lines(500, 200)}`,
  ];
  const { countTextStatsStreaming } = await load(`${bt}/text-stats.mjs`);
  const files = ['a\nb\0', 'a\né\0', '', 'x', 'a b\n', '\n\n', '한글 단어\n', 'one two\u00a0three\u3000four', 'tail without newline\nlast', '\r\nwin\r\n'];
  const dir = join(sandbox, 'stats');
  mkdirSync(dir, { recursive: true });
  const stats = [];
  for (const [index, text] of files.entries()) {
    const path = join(dir, `f${index}.txt`);
    const bytes = Buffer.from(text, 'utf8');
    writeFileSync(path, bytes);
    stats.push({ text, bytes: bytes.length, stats: await countTextStatsStreaming(path, bytes.length) });
  }
  sets['fs-shell-output'] = { maxBytes: SMART_BASH_MAX_BYTES, caps: inputs.map((input) => ({ input, output: capShellOutput(input) })), textStats: stats };
}

// ---- trace: failure classes (exit-classification.test.mjs, failure-taxonomy.test.mjs) ----
{
  const { classifyToolFailure } = await load(`${orch}/agent-trace-format.mjs`);
  const patch = (text) => [text, 'apply_patch'];
  const cases = [
    ['Error: [shell-run-failed] [exit code: 1]\n\ncommand timed out while parsing an aborted field', 'shell'],
    ['Error: [shell-run-failed] [signal: SIGKILL]\n\n(no output)', 'shell'],
    ['Error: [shell-run-failed] [timeout: 500ms signal: SIGTERM cause: timeout]', 'shell'],
    ['Error: [shell-run-failed] [signal: SIGTERM cause: cancellation]', 'shell'],
    ['Error: [shell-run-failed] [signal: SIGKILL cause: output-limit]', 'shell'],
    ['Session "sess_cancelled" closed: aborted during call', 'shell'],
    ['call aborted', 'read'],
    ['⚠️ destructive command warning\nError: [shell-run-failed] [signal: SIGKILL]', 'shell'],
    ['Error: [tool-input-validation] apply_patch received a compacted-history placeholder', 'apply_patch'],
    ['Error: apply_patch sequence stopped\ncontext not found; expected first old line: "before"', 'apply_patch'],
    ['Error: native patch failed — atomic write C:\\locked.txt: Access is denied. (os error 5)', 'apply_patch'],
    ['Error: unknown memory action: add', 'memory'],
    ['Error: path does not exist: C:/missing (ENOENT)', 'glob'],
    ['Error: no such path C:/missing/.', 'find'],
    ['Error: ENOENT: no such file or directory, stat C:/missing', 'read'],
    ['Error: path does not exist: C:/missing', 'grep'],
    ['Error: file not found in graph: src/missing.ts', 'code_graph'],
    ['Error: EACCES: permission denied, stat C:/private', 'read'],
    patch('Error: apply_patch preflight rejected section 1/1 (a.mjs); no files were written.\napply_patch: V4A parse failed — missing *** End Patch'),
    patch('Error: apply_patch: parse failed — hunk header mismatch; prefer V4A envelope for multi-hunk edits'),
    patch('Error: apply_patch preflight rejected section 2/13 (SourceControlDock.tsx); no files were written.\nV4A hunk SourceControlDock.tsx: context not found: (no anchor); expected first old line: "const [stashes"; nearest line 216: "const [stashes"; first divergent line: old[4] expected "}" vs file line 220 actual "  );"'),
    patch('Error: native patch failed — a/scripts/x.mjs: hunk rejected in a/scripts/x.mjs'),
    patch('Error: apply_patch preflight rejected section 1/1 (x.mjs); no files were written.\nV4A hunk x.mjs: context not found: (no anchor); expected first old line: "const a = 1;"; use exact current context or a broader @@ anchor; no stubs. Copy the context lines verbatim from the excerpt below — do not retype them from memory.\n  1 | const b = 2;'),
    patch('Error: apply_patch preflight rejected section 1/1 (x.mjs); no files were written.\nV4A hunk anchor not found: function build > const rows; use an existing @@ anchor from the current file or add exact context lines; no stubs.'),
    patch('Error: patch contained no file sections'),
    patch('Error: apply_patch: patch contained no file sections'),
    patch('Error: apply_patch preflight rejected section 1/1 (x.mjs); no files were written.\napply_patch: V4A parse failed — V4A patch contained no file sections'),
    patch('Error: apply_patch: V4A parse failed — V4A hunk x.mjs: context not found: (no anchor); expected first old line: "const a = 1;"; nearest line 8: "const a = 1;"; first divergent line: old[2] expected "x" vs file line 9 actual "y"'),
    patch('Error: apply_patch: V4A parse failed — apply_patch: multiple operations target src/x.mjs'),
    patch('Error: apply_patch: V4A parse failed — apply_patch: conflicting operations target src/x.mjs'),
    patch('Error: apply_patch: 1 target(s) fall outside the write root C:/Project/mixdog: C:/tmp/x.mjs'),
    patch('Error: native patch failed — refusing hunkless delete: x.mjs is non-empty'),
    patch('Error: apply_patch preflight rejected section 1/2 (x.mjs); no files were written.\napply_patch: only one V4A rename (*** Move to:) per patch is supported; split into separate patches.'),
    patch('Error: apply_patch preflight rejected section 1/1 (x.mjs); no files were written.\nV4A update target unreadable: x.mjs (ENOENT).'),
    patch('Error: apply_patch: patch too large (9000000 bytes > 4194304 byte cap); split into smaller patches'),
    patch('Error: advisory lock timeout: C:\\Project\\mixdog\\src\\.UtilityDock.tsx.mixdog-lock held by pid 53232'),
    patch('Error: apply_patch: a block failed in sequential group 1/2; every edit listed below was already applied to disk (writes committed) and left in place:'),
    patch('Error: apply_patch sequence stopped at section 2/3 (a.mjs); 1 earlier section(s) were applied to disk (committed) and left in place; 1 later section(s) were skipped (not attempted).\n--- applied (committed to disk) ---\nApplied 1 File\n--- failed section: a.mjs ---\nV4A hunk a.mjs: context not found: (no anchor); expected first old line: "x"'),
    patch('Error: apply_patch: "format" must be "unified" or "v4a"'),
    patch('Error: apply_patch: Add File target already exists: src/existing.mjs; read it and use Update File instead'),
    patch('Error: native patch failed — a/src/missing.mjs: stat C:/Project/src/missing.mjs for delete: file not found (os error 2)'),
    patch('Error: apply_patch sequence stopped at section 2/2 (a.mjs); 1 earlier section(s) were applied, but rollback was incomplete; 0 later section(s) were skipped (not attempted).\n--- applied before rollback ---\nApplied 1 File\n--- failed section: a.mjs ---\nadvisory lock timeout: C:\\Project\\mixdog\\src\\.a.mjs.mixdog-lock held by pid 91\n--- rollback incomplete ---\napply_patch: rollback restore failed for a.mjs'),
    patch('Error: apply_patch sequence stopped at section 3/4 (b.mjs); 2 earlier section(s) were applied to disk (committed) and left in place; 1 later section(s) were skipped (not attempted).\n--- failed section: b.mjs ---\nnative patch failed — atomic write C:\\locked.txt: Access is denied. (os error 5)'),
    patch('Error: advisory lock timeout: C:\\Project\\mixdog\\src\\.a.mjs.mixdog-lock held by pid 91'),
    ['Error: [shell-run-failed] [exit code: 1]\n\nerror: patch failed: src/a.mjs:12\nhunk rejected; context not found', 'shell'],
    ['Error: [exit code: 1]\n\n1 test failed; hunk rejected in a/x.mjs', 'shell'],
    ['Error: [shell-run-failed] [exit code: 1]\n[auto-rewrite: deprecated wmic process query -> PowerShell; timeout capped at 30000ms]\n(no output)', 'shell'],
  ];
  sets['trace-classify'] = { cases: cases.map(([text, tool]) => ({ text, tool, category: classifyToolFailure(text, tool) })) };
}

// ---- agent: tool call ids (session/tool-call-ids.test.mjs) ----
{
  const { createToolCallIdResolver } = await load(`${orch}/session/loop/tool-call-ids.mjs`);
  const call = (id) => ({ id, name: 't', arguments: {} });
  const turn = (ids) => [{ role: 'assistant', content: '', toolCalls: ids.map(call) }, ...ids.map((id) => ({ role: 'tool', toolCallId: id, content: 'r' }))];
  // history: the ids of each earlier assistant turn; a round: the calls the stream finished (`streamed`, each its own value), then the
  // final batch of the response (`final`); the ids a round ends with are appended to the history as one more turn.
  const run = ({ history, rounds }) => {
    const messages = [{ role: 'user', content: 'x' }, ...history.flatMap(turn)];
    return rounds.map((round) => {
      const resolve = createToolCallIdResolver(messages);
      const streamed = (round.streamed ?? []).map((id) => resolve(call(id)).id);
      const batch = round.final ? round.final.map(call) : null;
      if (batch) resolve.all(batch);
      const final = batch ? batch.map((c) => c.id) : null;
      messages.push(...turn(final ?? streamed));
      return { ...round, streamedOut: streamed, finalOut: final };
    });
  };
  const scenarios = [
    { name: 'a streamed call and its final copy are renamed past the history together', history: [['a'], ['a-2']], rounds: [{ streamed: ['a', 'b'], final: ['a', 'b'] }] },
    { name: 'history {a}, batch {a, a-2}', history: [['a']], rounds: [{ final: ['a', 'a-2'] }] },
    { name: 'history {a}, batch {a-2, a}', history: [['a']], rounds: [{ final: ['a-2', 'a'] }] },
    { name: 'no history, batch {a-2, a}', history: [], rounds: [{ final: ['a-2', 'a'] }] },
    { name: 'no history, batch {a, a}', history: [], rounds: [{ final: ['a', 'a'] }] },
    { name: 'history {a}, batch {a, a}', history: [['a']], rounds: [{ final: ['a', 'a'] }] },
    { name: 'streamed calls and the final batch agree and stay distinct', history: [['a']], rounds: [{ streamed: ['a', 'a-2', 'a'], final: ['a', 'a-2', 'a'] }] },
    { name: 'the streamed call is also in the final batch with a second call of its id', history: [['a']], rounds: [{ streamed: ['a'], final: ['a', 'a'] }] },
    { name: 'five rounds of {call_1, call_1}', history: [], rounds: Array.from({ length: 5 }, () => ({ final: ['call_1', 'call_1'] })) },
    { name: 'five streamed rounds of {call_1, call_1-2}', history: [], rounds: Array.from({ length: 5 }, () => ({ streamed: ['call_1', 'call_1-2'], final: ['call_1', 'call_1-2'] })) },
    { name: 'a streamed call the final batch does not repeat', history: [['a']], rounds: [{ streamed: ['a', 'b'], final: ['b'] }] },
  ];
  sets['agent-tool-call-ids'] = { scenarios: scenarios.map((s) => ({ ...s, rounds: run(s) })) };
  notes['agent-tool-call-ids'] = 'a call object that is both streamed and in the final batch (the identity cases of the Node test) is not recorded: the Rust core receives the final batch as separate values';
}

// ---- agent: repeated-failure signatures (session/eager-dispatch.test.mjs :110) ----
{
  const classify = await load(`${orch}/session/loop/tool-classify.mjs`);
  const cwd = process.cwd();
  const MCP = 'mcp__plugin_mixdog_mixdog__';
  const calls = [
    ['read', { file_path: 'missing/file.txt' }, cwd],
    ['read', { file_path: `${cwd}/missing/file.txt` }, cwd],
    ['read', { file_path: 'missing/other.txt' }, cwd],
    ['read', { file_path: `${cwd}\\missing\\file.txt` }, cwd],
    ['read', { file_path: `${cwd.toUpperCase()}/MISSING/file.txt` }, cwd],
    ['read', { file_path: './missing/../missing/file.txt' }, cwd],
    ['read', { path: 'a/./b/../c.txt', limit: 5, offset: 1 }, 'C:\\work'],
    ['read', { path: 'C:/work/sub/../c.txt' }, 'C:\\work'],
    ['read', { path: '/abs/rooted.txt' }, 'C:\\work'],
    ['read', { path: '' }, 'C:\\work'],
    ['read', { path: 'https://example.com/a/../b' }, 'C:\\work'],
    ['read', { path: 'file:///C:/x' }, 'C:\\work'],
    ['read', { path: ['a.txt', 'b/../c.txt', 7, null] }, 'C:\\work'],
    ['grep', { pattern: 'x', Path: 'src/../lib', paths: ['One.TXT'], files: ['a/b'], dir: 'd', dir_path: 'e', directory: 'f', base_path: 'g', cwd: 'h' }, 'C:\\work'],
    ['grep', { pattern: 'path', glob: 'src/../*.rs', nested: { path: 'n/../m', z: 1, a: [{ file_path: 'q/../r' }] } }, 'C:\\work'],
    ['shell', { command: 'ls ..', cwd: 'sub/..' }, 'C:\\work'],
    [`${MCP}read`, { path: 'x' }, 'C:\\work'],
    ['x', { b: 1, a: { d: [3, 2, 1], c: null }, 'é': 1, 'Z': 2, '\ud83d\ude00': 3, '\uffff': 4 }, 'C:\\work'],
    ['x', { n: 1.5, big: 1e21, neg: -0, t: true, s: 'quote"back\\slash\nnl' }, 'C:\\work'],
    ['x', {}, 'C:\\work'],
    ['x', null, 'C:\\work'],
    ['x', 'text', 'C:\\work'],
    ['x', [1, { path: 'p/../q' }], 'C:\\work'],
  ];
  // A tool call's arguments are a JSON object: the signature of any other value (Node writes an array as an object keyed by index) is
  // input no client can send, and is not recorded.
  const intra = calls.filter((c) => c[1] !== null && typeof c[1] === 'object' && !Array.isArray(c[1])).map(([name, args]) => [name, args]);
  const signatures = calls.map(([name, args, base]) => ({ name, args, cwd: base, repeatFailureSig: classify._repeatFailureSig(name, args, base) }));
  const shapes = intra.map(([name, args]) => ({ name, args, intraTurnSig: classify._intraTurnSig(name, args), argShapeSig: classify._argShapeSig(name, args) }));
  const sig = (name) => classify._repeatFailureSig('read', { file_path: name }, cwd);
  const [relative, other, third] = [sig('missing/file.txt'), sig('missing/other.txt'), sig('missing/third.txt')];
  const histories = [
    [relative, other, relative, other, relative, other], [relative, relative, relative], [relative, relative], [], [relative],
    [other, relative, relative, relative], [relative, other, third, relative, other, third, relative, other, third],
    [relative, other, third, relative, other, third], Array.from({ length: 5 }, () => [relative, other, third, relative, other]).flat(),
    Array.from({ length: 12 }, (_, i) => [relative, other, third, relative, other][i % 5]),
    Array.from({ length: 15 }, (_, i) => [relative, other, third, relative, other][i % 5]),
    Array.from({ length: 12 }, () => relative),
  ];
  const continues = [];
  for (const history of histories) {
    for (const signature of [relative, other, third, 'read:{}']) {
      for (const limit of [1, 2, 3, 4]) continues.push({ history, signature, limit, cycle: classify._repeatFailurePatternWouldContinue(history, signature, limit) });
    }
  }
  sets['agent-repeat-signature'] = { cwd, signatures, shapes, continues };
}

// ---- scm: the git repository write lock (tools/builtin/git-repo-rw-lock.test.mjs) ----
{
  const { gitRepoLockKey, withGitRepoWriteLock, withGitWorktreeWriteLock } = await load(`${bt}/git-repo-rw-lock.mjs`);
  const root = join(sandbox, 'lock-root');
  mkdirSync(join(root, 'Repo', '.git', 'x'), { recursive: true });
  mkdirSync(join(root, 'Worktree'), { recursive: true });
  const dir = join(root, 'Repo', '.git');
  const place = (text) => String(text).replaceAll('<ROOT>', root);
  const unplace = (text) => String(text).replaceAll(root, '<ROOT>');
  const spellings = [
    '<ROOT>\\Repo\\.git', '<ROOT>\\Repo\\.git/', '<ROOT>\\Repo\\.git\\x\\..', '<ROOT>\\REPO\\.GIT', '<ROOT>/Repo/.git', '<ROOT>\\Repo\\.git\\', '<ROOT>\\Repo\\.git\\.', '<ROOT>\\Repo\\.git\\x', '<ROOT>\\Repo\\other',
  ];
  const keys = spellings.map((s) => gitRepoLockKey(place(s)));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const scenarios = [
    { name: 'writes on different worktrees run together; writes on one worktree run one at a time in order', ops: [
      { op: 'run', name: 'a1', repo: 'repo-scope', scopes: ['wt-a'], hold: true }, { op: 'run', name: 'a2', repo: 'repo-scope', scopes: ['wt-a'], hold: true },
      { op: 'run', name: 'b', repo: 'repo-scope', scopes: ['wt-b'], hold: true }, { op: 'settle' }, { op: 'snapshot' },
      { op: 'release', name: 'a1' }, { op: 'await', name: 'a1' }, { op: 'settle' }, { op: 'snapshot' }, { op: 'release', name: 'a2' }, { op: 'release', name: 'b' }, { op: 'await', name: 'a2' }, { op: 'await', name: 'b' }] },
    { name: 'a write naming several worktrees conflicts with a write on any of them', ops: [
      { op: 'run', name: 'move', repo: 'repo-multi', scopes: ['wt-a', 'wt-new'], hold: true }, { op: 'run', name: 'a', repo: 'repo-multi', scopes: ['wt-a'] },
      { op: 'run', name: 'new', repo: 'repo-multi', scopes: ['wt-new'] }, { op: 'run', name: 'b', repo: 'repo-multi', scopes: ['wt-b'] }, { op: 'await', name: 'b' }, { op: 'settle' }, { op: 'snapshot' },
      { op: 'release', name: 'move' }, { op: 'await', name: 'move' }, { op: 'await', name: 'a' }, { op: 'await', name: 'new' }] },
    { name: 'a waiting whole-repository write is never starved by later worktree writes', ops: [
      { op: 'run', name: 'a', repo: 'repo-starve', scopes: ['wt-a'], hold: true }, { op: 'run', name: 'repo', repo: 'repo-starve', scopes: 'whole', hold: true },
      { op: 'run', name: 'b', repo: 'repo-starve', scopes: ['wt-b'] }, { op: 'run', name: 'a2', repo: 'repo-starve', scopes: ['wt-a'] }, { op: 'settle' }, { op: 'snapshot' },
      { op: 'release', name: 'a' }, { op: 'await', name: 'a' }, { op: 'settle' }, { op: 'snapshot' }, { op: 'release', name: 'repo' }, { op: 'await', name: 'repo' }, { op: 'await', name: 'b' }, { op: 'await', name: 'a2' }] },
    { name: 'a later write that conflicts with nothing ahead of it is not held back by a queue', ops: [
      { op: 'run', name: 'a', repo: 'repo-convoy', scopes: ['wt-a'], hold: true }, { op: 'run', name: 'a2', repo: 'repo-convoy', scopes: ['wt-a'] }, { op: 'run', name: 'b', repo: 'repo-convoy', scopes: ['wt-b'] },
      { op: 'await', name: 'b' }, { op: 'snapshot' }, { op: 'release', name: 'a' }, { op: 'await', name: 'a' }, { op: 'await', name: 'a2' }] },
    { name: 'worktree scopes are canonical paths; an empty scope holds the whole repository', ops: [
      { op: 'run', name: 'held', repo: '<ROOT>\\.git', scopes: ['<ROOT>\\Worktree'], hold: true }, { op: 'run', name: 'same', repo: '<ROOT>\\.git', scopes: ['<ROOT>\\WORKTREE\\'] },
      { op: 'run', name: 'whole', repo: '<ROOT>\\.git', scopes: [] }, { op: 'run', name: 'none', repo: '<ROOT>\\.git', scopes: null }, { op: 'settle' }, { op: 'snapshot' },
      { op: 'release', name: 'held' }, { op: 'await', name: 'held' }, { op: 'await', name: 'same' }, { op: 'await', name: 'whole' }, { op: 'await', name: 'none' }] },
    { name: 'writers on different repositories run in parallel', ops: [
      { op: 'run', name: 'first', repo: 'repo-a', scopes: 'whole', hold: true }, { op: 'run', name: 'second', repo: 'repo-b', scopes: 'whole', hold: true }, { op: 'settle' }, { op: 'snapshot' },
      { op: 'release', name: 'first' }, { op: 'release', name: 'second' }, { op: 'await', name: 'first' }, { op: 'await', name: 'second' }] },
    { name: 'a queued write aborts without running or blocking later work', ops: [
      { op: 'run', name: 'writer', repo: 'repo-abort', scopes: ['wt-a'], hold: true }, { op: 'run', name: 'queued', repo: 'repo-abort', scopes: 'whole', abortable: true },
      { op: 'run', name: 'behind', repo: 'repo-abort', scopes: ['wt-b'] }, { op: 'abort', name: 'queued' }, { op: 'await', name: 'behind' }, { op: 'snapshot' },
      { op: 'release', name: 'writer' }, { op: 'await', name: 'writer' }, { op: 'run', name: 'after', repo: 'repo-abort', scopes: 'whole' }, { op: 'await', name: 'after' }] },
  ];
  const recordedScenarios = [];
  for (const scenario of scenarios) {
    const events = [];
    const rejected = [];
    const tasks = new Map();
    const snapshots = [];
    for (const op of scenario.ops) {
      if (op.op === 'run') {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const body = op.hold ? async () => { events.push(`${op.name}:start`); await gate; events.push(`${op.name}:end`); } : () => { events.push(op.name); };
        const controller = op.abortable ? new AbortController() : null;
        const options = controller ? { signal: controller.signal } : {};
        const repo = place(op.repo);
        const scopes = op.scopes === 'whole' ? null : op.scopes;
        const promise = (scopes === null && op.scopes === 'whole' ? withGitRepoWriteLock(repo, body, options) : withGitWorktreeWriteLock(repo, scopes?.map(place) ?? null, body, options))
          .catch((error) => { rejected.push(`${op.name}: ${error.name}`); });
        tasks.set(op.name, { release, controller, promise });
      } else if (op.op === 'settle') await settle();
      else if (op.op === 'snapshot') snapshots.push([...events]);
      else if (op.op === 'release') tasks.get(op.name).release();
      else if (op.op === 'abort') { tasks.get(op.name).controller.abort(); await settle(); }
      else if (op.op === 'await') await tasks.get(op.name).promise;
    }
    recordedScenarios.push({ ...scenario, snapshots, events: events.map(unplace), rejected });
  }
  sets['scm-locks'] = { platform: process.platform, keys: spellings.map((spelling, index) => ({ spelling, sameAsFirst: keys[index] === keys[0] })), scenarios: recordedScenarios };
  notes['scm-locks'] = 'the realpath spelling of the Node key test is textually the directory itself on the recording machine; the key of a path is compared by spelling equality only';
}

// ---- fs: the default page of `list` (builtin/list-tool-integrity.test.mjs :33) ----
{
  const { executeBuiltinTool } = await load(`${bt}.mjs`);
  const { normalizeToolEnvelope } = await load(`${orch}/session/tool-envelope.mjs`);
  const root = join(sandbox, 'list-page');
  mkdirSync(root, { recursive: true });
  for (let index = 0; index < 101; index += 1) writeFileSync(join(root, `entry-${String(index).padStart(3, '0')}.txt`), 'ok');
  const fwd = root.replace(/\\/g, '/');
  const scrub = (text) => String(text).replaceAll(root, '<ROOT>').replaceAll(fwd, '<ROOT>');
  const inputs = [
    { path: '<ROOT>', hidden: true }, { path: '<ROOT>', hidden: true, head_limit: 200 }, { path: '<ROOT>', hidden: true, head_limit: 100 },
    { path: '<ROOT>', hidden: true, head_limit: 10, offset: 95 }, { path: '<ROOT>', hidden: true, offset: 100 }, { path: '<ROOT>', hidden: true, offset: 101 }, { path: '<ROOT>', hidden: true, head_limit: 0 },
    { path: '<ROOT>' },
  ];
  const calls = [];
  for (const input of inputs) {
    const given = { ...input, path: input.path.replace('<ROOT>', root) };
    const envelope = normalizeToolEnvelope(await executeBuiltinTool('list', given, root));
    calls.push({ input, text: scrub(envelope.result ?? ''), isError: envelope.isError === true || /^Error[\s:[]/.test(String(envelope.result ?? '')) });
  }
  sets['fs-list-page'] = { count: 101, calls };
}

// ---- web: documents (web-search/lib/document-content.test.mjs) ----
{
  const { extractDocument } = await load('src/runtime/web-search/lib/document-content.mjs');
  const guide = 'https://example.com/guide';
  const challenge = (title) => `<title>${title}</title>
      <main><h1>${title}</h1><p>When checking your browser, you may see “Please enable JavaScript”.</p>
      <p>This guide explains how to verify you are human and sign in.</p></main>`;
  const cases = [
    [guide, '# Guide\n\n<div>Example, not an HTML page</div>\n\n\n    indented code\n', 'text/plain'],
    [guide, '# Guide\n\n```html\n<main>hello</main>\n```\n', 'text/markdown'],
    [guide, '{\n  "name": "<main>literal</main>"\n}\n', 'application/ld+json'],
    [guide, '<feed><item>example</item></feed>', 'application/xml'],
    ['https://example.com/docs/start', `
    <title>Setup</title><nav>Navigation noise</nav>
    <main><h1>Setup guide</h1><p>Use <a href="../api">the API</a>.</p>
    <pre><code class="language-js">const x = 1;


  console.log(x);</code></pre>
    <table><tr><th>Option</th><th>Value</th></tr><tr><td>port</td><td>8080</td></tr></table>
    <ul><li>First</li><li>Second</li></ul><div hidden>Hidden noise</div>
    <script>throw new Error('must not execute')</script></main><aside>Advertisement</aside>`, 'text/html'],
    ['https://example.com', '<meta property="og:image" content="/cover.png"><div id="root"></div><script>render()</script>', 'text/html'],
    ['https://example.com', '<title>Small page</title><div><p>A small useful page.</p><p>More details here.</p></div>', 'text/html'],
    ['https://example.com/docs', challenge('Just a moment...'), 'text/html'],
    ['https://example.com/docs', challenge('Access denied'), 'text/html'],
    ['https://example.com/docs', challenge('Sign in - Example'), 'text/html'],
  ];
  const outcomes = [];
  for (const [url, body, contentType] of cases) {
    try {
      const page = await extractDocument(url, body, contentType);
      outcomes.push({ url, body, contentType, content: page.content, extractor: page.extractor, title: page.title });
    } catch (error) {
      outcomes.push({ url, body, contentType, errorCode: error.code ?? null });
    }
  }
  sets['web-extract'] = { cases: outcomes };
}

// ---- web: search output (web-search/lib/fetch-output.test.mjs) ----
{
  const { formatResponse } = await load('src/runtime/web-search/lib/formatter.mjs');
  const url = 'https://example.com/document.md';
  const cited = 'https://example.com/cited';
  const extra = 'https://example.com/extra';
  const titled = 'https://example.com/titled';
  const responses = [
    { results: [], warnings: ['provider timed out', 'partial results'] },
    { results: [] },
    { results: [
      { title: 'Same title', url, snippet: 'Same title', publishedDate: '2026-09-21' },
      { title: 'URL repeat', url, snippet: url },
      { title: 'Distinct', url, snippet: 'Different details, kept intact.' },
    ] },
    { answer: `Summary citing ${cited}.`, results: [
      { title: 'the query', url: cited, snippet: '', source: 'web_search_call' },
      { title: 'the query', url: extra, snippet: '', source: 'web_search_call', publishedDate: '2026-09-21' },
      { title: 'A page title', url: titled, snippet: '' },
    ] },
    { results: [{ title: 'shared label', url: cited }, { title: 'shared label', url: extra }] },
    { answer: `Guide: ${cited}/guide and ${extra}.`, results: [{ title: 'q', url: cited, source: 'web_search_call' }, { title: 'q', url: extra, source: 'web_search_call' }] },
    { answer: `See ${cited}`, results: [{ title: cited, url: cited }] },
    { answer: 'x'.repeat(5000), results: [] },
    { answer: '', results: [{ title: 'T'.repeat(300), url, snippet: `  ${'s'.repeat(700)}  ` }] },
    { answer: 'Answer.', results: [{ title: '', url, snippet: '' }, { title: 'No url', url: '', snippet: 'only a snippet' }] },
    { answer: `Dot ${cited}. and ${extra}.html`, results: [{ title: 'q', url: cited, source: 'web_search_call' }, { title: 'q', url: extra, source: 'web_search_call' }] },
  ];
  sets['web-search-format'] = {
    cases: responses.map((response) => {
      // Node's formatter takes the answer both as `{ response }` (what its cache stores) and as the bare response.
      const wrapped = formatResponse('web_search', { response });
      const bare = formatResponse('web_search', response);
      return { response, text: wrapped, bareFormSameText: bare === wrapped };
    }),
  };
}

// ---- fs: blank lines in a V4A patch (tools/patch/v4a-blank-context.test.mjs) ----
{
  const { parseV4APatch } = await load(`${orch}/tools/patch/parsing.mjs`);
  const wrap = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');
  const patches = [
    wrap('*** Update File: a.txt', '@@ anchor', ' first', '', ' second', '-drop me', '+keep me'),
    wrap('*** Update File: a.txt', '', '@@ anchor', ' first', '-drop me', '+keep me'),
    wrap('*** Update File: a.txt', '@@ anchor', ' first', '', '', ' second', '-x', '+y'),
    wrap('*** Update File: a.txt', '@@', '', ' first', '-x', '+y'),
    wrap('*** Update File: a.txt', '@@ one', ' first', '-x', '', '@@ two', ' second', '', '-y', '+z'),
    wrap('*** Update File: a.txt', '@@ one', ' first', '-x', '+y', '', '*** Update File: b.txt', '@@', '-b', '+B'),
    wrap('*** Update File: a.txt', '@@ one', ' first', '-x', '+y', '', '*** End of File'),
    wrap('*** Update File: a.txt', '*** Move to: b.txt', '@@ one', ' first', '', ' last', '-x', '+y'),
    wrap('*** Add File: n.txt', '+x', '', '+y', ''),
    wrap('*** Delete File: d.txt', '', '*** Update File: a.txt', '@@', '-a', '+b'),
    ['*** Begin Patch', '*** Update File: a.txt', '@@ anchor', ' first', '', ' second', '-drop me', '+keep me', '*** End Patch'].join('\n'),
    ['*** Begin Patch', '*** Update File: a.txt', '@@ anchor', ' first', '', ' second', '-drop me', '+keep me', '*** End Patch', ''].join('\r\n'),
    wrap('*** Update File: a.txt', ' first', '', ' second', '-drop me', '+keep me'),
    wrap('*** Update File: a.txt', '', ''),
    wrap(''),
    wrap('', '*** Update File: a.txt', '@@', '-a', '+b'),
  ];
  const parsed = patches.map((patch) => {
    try {
      return { patch, files: parseV4APatch(patch).map((f) => ({ kind: f.kind, path: f.path, movePath: f.movePath ?? null, lines: f.lines, hunks: f.hunks.map((h) => ({ anchors: h.anchors, lines: h.lines, endOfFile: h.isEndOfFile === true })) })) };
    } catch (error) {
      return { patch, error: error.message };
    }
  });
  sets['fs-patch-parse'] = { patches: parsed };
}

// ---- write ----
const finalDir = join(FIXTURES_ROOT, 'tools-untested');
const out = stageSet(finalDir);
for (const [name, value] of Object.entries(sets)) writeJson(join(out, `${name}.json`), { note: notes[name] ?? null, ...value });
writeSetManifest(out, {
  set: 'tools-untested',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    modules: Object.keys(sets),
    exclusions: {
      'exec-hoist-long': 'the command text is not repeated in a plan that equals it (`<SAME>`, `<COMMAND>`): a 30 KB command would be stored three times; the replay compares the plan with the command it was given',
      'exec-env': `the skill launcher directory is the recording's data folder under the sandbox: stored as <LAUNCHER>`,
      'fs-markers': 'capMarker cursor/fullPath and windowMarker offsetKey are not recorded: the Rust markers have no caller that passes them',
      'exec-deadline': 'Node\'s timeout and promotedTimeoutMs are not compared (the core cuts the foreground window where it waits, from the same hold and cap); MIXDOG_SHELL_BACKGROUND_MAX_MS, an operator net the Node test does not cover, is not recorded: the core applies it to the foreground run as well as to the promoted job',
      'agent-tool-call-ids': 'a call object that is both streamed and in the final batch (the identity cases of the Node test) is not recorded: the Rust core receives the final batch as separate values; the same scenarios are recorded with separate values',
      'scm-locks': 'the realpath spelling of the Node key test is textually the directory itself on the recording machine, so it is not a separate case; the "rejected" outcome of an aborted wait is a list apart from the events, because the order of a promise\'s rejection handler against another task\'s start is a tick of Node\'s promise queue, not a behaviour',
    },
  },
});
commitStage(out, finalDir);
rmSync(sandbox, { recursive: true, force: true });
console.log(`sets=${Object.keys(sets).join(',')}`);
process.exit(0);
