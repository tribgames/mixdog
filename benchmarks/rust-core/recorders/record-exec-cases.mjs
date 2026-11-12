#!/usr/bin/env node
// Records what Node's shell tool does for the cases of the Node tests whose behaviour the Rust `exec` module has but no Rust
// test proved (k1 gaps-tools.md section 3, `mixdog-tools/src/exec`). Each scenario runs Node's own code at b6f10295a, in a
// process of its own (the Node tests replace `execShellCommand` and the preflight with `mock.module`, so a scenario that does
// needs a fresh module graph), inside a Windows job that ends the whole tree it started.
//
//   node benchmarks/rust-core/recorders/record-exec-cases.mjs --tree <exact export of b6f10295a with node_modules> --work <temp dir>
//   [--only <scenario>]   runs one scenario and prints its record; the fixture set is written only by a full run.
//
// Output: native/core/fixtures/exec-cases/golden.json (+ MANIFEST.json), one entry per scenario in the order below.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-exec-cases.mjs';
const B = 'src/runtime/agent/orchestrator/tools/builtin';
const T = 'src/runtime/agent/orchestrator/tools';
/** One scenario's process may take this long (its own deadline; the job ends what it left). */
const SCENARIO_MS = 120_000;

const url = (tree, rel) => pathToFileURL(join(tree, rel)).href;
const load = (tree, rel) => import(url(tree, rel));

/** `mock.module` replacements of the Node tests: `execShellCommand` answers `answer` and keeps what it was given. */
async function mockShell(tree, mock, answer, { preflight = null, invocationPlan = null } = {}) {
  const seen = [];
  mock.module(url(tree, `${T}/shell-command.mjs`), {
    namedExports: {
      execShellCommand: async (input) => {
        seen.push(input);
        return typeof answer === 'function' ? answer(input) : answer;
      },
      stripAnsi: (text) => text,
    },
  });
  if (preflight) mock.module(url(tree, `${B}/bash-tool/command-preflight.mjs`), { namedExports: { prepareShellCommand: preflight } });
  if (invocationPlan) mock.module(url(tree, `${B}/bash-tool/invocation-plan.mjs`), { namedExports: { planShellInvocation: invocationPlan } });
  return seen;
}

/** The preflight the Node tests script: the command as given, run by Windows PowerShell. */
const powershellPreflight = ({ command }) => ({
  command,
  analysisCommand: command,
  resolvedSpec: { shell: 'powershell.exe', shellArg: '-Command', shellArgs: [], shellType: 'powershell' },
});
const posixPreflight = ({ command }) => ({ command, analysisCommand: command, resolvedSpec: { shellType: 'posix' } });

/** script-transport.slow.test.mjs' long inline command and oversized PowerShell body. */
const LONG_INLINE = `node -e '${`const slash = "\\\\"; /*${'x'.repeat(25_000)}*/ console.log("ok")`}'`;
/** The hoisted file in `text` (a path in the temp dir, the recorder's work dir), without its extension. */
function hoistedPath(text, tmp) {
  for (const dir of [tmp, tmp.replace(/\\/g, '/')]) {
    const at = text.indexOf(dir);
    if (at >= 0) return /^[^"']*?(?=\.(?:cjs|mjs|js|ps1)\b)/.exec(text.slice(at))?.[0] ?? null;
  }
  return null;
}

/** Each `[spec, command]` through the whole tool: what the shell is handed, the hoisted file it reads, the result. */
async function recordScriptFileTransport(tree, work, mock, runs, posix = posixPreflight) {
  const { readFileSync } = await import('node:fs');
  const tmp = (await import('node:os')).tmpdir();
  let spec = 'powershell';
  const files = [];
  const seen = await mockShell(
    tree,
    mock,
    (input) => {
      const path = hoistedPath(input.command, tmp);
      const ext = path ? /^\.\w+/.exec(input.command.slice(input.command.indexOf(path) + path.length))[0] : '';
      files.push(path ? readFileSync(path + ext, 'utf8') : null);
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    },
    { preflight: (input) => (spec === 'powershell' ? powershellPreflight : posix)(input) },
  );
  const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
  const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
  const cases = [];
  for (const [shell, command] of runs) {
    spec = shell;
    const result = normalizeToolEnvelope(await executeBashTool({ command }, work)).result;
    const ran = seen.at(-1).command;
    const path = hoistedPath(ran, tmp);
    cases.push({ spec: shell, command, ran: path ? ran.split(path).join('<FILE>') : ran, file: files.at(-1), result });
  }
  return { platform: process.platform, cases };
}

const SCENARIOS = [
  {
    // deadline-plan.test.mjs: every case of the six tests, with the environment each sets.
    name: 'deadline-plan',
    test: `${B}/bash-tool/deadline-plan.test.mjs`,
    async run(tree) {
      const { planShellDeadlines } = await load(tree, `${B}/bash-tool/deadline-plan.mjs`);
      const cases = [];
      const plan = (env, args, backgroundOnTimeout) => {
        for (const name of ['MIXDOG_SHELL_AUTO_BACKGROUND_MS', 'BASH_MAX_TIMEOUT_MS', 'MIXDOG_SHELL_BACKGROUND_MAX_MS']) {
          if (env[name] === undefined) delete process.env[name];
          else process.env[name] = env[name];
        }
        cases.push({ env, args, backgroundOnTimeout, plan: planShellDeadlines({ args, backgroundOnTimeout }) });
      };
      for (const args of [{}, { wait_ms: 20_000 }, { wait_ms: 5_000 }, { wait_ms: 300_000 }, { wait_ms: 5_000_000 }, { wait_ms: 10 }]) plan({}, args, true);
      plan({}, { timeout_ms: 4000 }, true);
      plan({}, { timeout_ms: 300_000 }, true);
      plan({}, { background: true }, true);
      plan({}, { background: true, wait_ms: 90_000 }, true);
      for (const args of [{}, { wait_ms: 45_000 }]) plan({ MIXDOG_SHELL_AUTO_BACKGROUND_MS: '20000' }, args, true);
      for (const args of [{}, { wait_ms: 20_000 }]) plan({ MIXDOG_SHELL_AUTO_BACKGROUND_MS: '0' }, args, true);
      plan({}, { wait_ms: 60_000 }, false);
      return { cases };
    },
  },
  {
    // bash-tool-cwd-env.test.mjs, its two tests through the whole tool: the daemon env is replaced by the test's (a stale
    // MIXDOG_SESSION_CWD; then `PATH=A;B`), and a run in the test's cwd hands the shell the env recorded whole, with the
    // launchers written under the data dir. `<WORK>` stands for the recorder's work dir in every value.
    name: 'spawn-env',
    test: `${B}/bash-tool-cwd-env.test.mjs`,
    mocks: true,
    async run(tree, work, mock) {
      const { readFileSync, readdirSync } = await import('node:fs');
      const { isDeepStrictEqual } = await import('node:util');
      const { delimiter } = await import('node:path');
      const dataDir = join(work, 'data');
      const keep = { SystemRoot: process.env.SystemRoot, MIXDOG_DATA_DIR: dataDir };
      const seen = await mockShell(tree, mock, { stdout: '', stderr: '', exitCode: 0, signal: null }, {
        preflight: ({ command }) => ({
          command,
          analysisCommand: command,
          resolvedSpec: { shell: 'powershell.exe', shellArg: '-Command', shellArgs: [], shellType: 'powershell' },
        }),
      });
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const { skillLauncherDir, skillScriptRuntime } = await load(tree, 'src/runtime/shared/skill-script-runtime.mjs');
      const runtime = skillScriptRuntime();
      const dir = skillLauncherDir(runtime, dataDir);
      const runs = [
        { base: { PATH: ['C:\\P1', 'C:\\P2'].join(delimiter), MIXDOG_SESSION_CWD: 'C:\\wrong-session' }, cwd: ['Project', 'mixdog'] },
        { base: { PATH: ['A', 'B'].join(delimiter) }, cwd: ['x'] },
      ];
      const cases = [];
      for (const run of runs) {
        const base = { ...keep, ...run.base };
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, base);
        const cwd = join(work, ...run.cwd);
        mkdirSync(cwd, { recursive: true });
        await executeBashTool({ command: 'echo hi' }, cwd, { sessionId: 't' });
        const env = seen.at(-1).env;
        cases.push({ base: { ...base }, cwd: run.cwd, env: { ...env }, daemonEnvKept: isDeepStrictEqual({ ...process.env }, base) });
      }
      const files = readdirSync(dir).sort().map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }));
      const record = { runtime: { platform: runtime.platform, interpreter: runtime.interpreter, entry: runtime.entry, electron: runtime.electron }, dir, cases, files };
      return JSON.parse(JSON.stringify(record).split(JSON.stringify(work).slice(1, -1)).join('<WORK>'));
    },
  },
  {
    // script-transport.slow.test.mjs 'long Windows inline scripts use a short file-backed shell loader' and 'generic oversized
    // PowerShell commands use a safe whole-script transport', each command through the whole tool on a Windows PowerShell or
    // a posix spec: the text the shell is handed (the hoisted file's path as <FILE> before its extension) and the hoisted
    // file read when the shell starts. The test's linux case is the scenario `script-file-transport-linux`.
    name: 'script-file-transport',
    test: 'scripts/shellhardening/script-transport.slow.test.mjs',
    mocks: true,
    run: (tree, work, mock) => recordScriptFileTransport(tree, work, mock, [
      ['powershell', LONG_INLINE],
      ['posix', LONG_INLINE],
      ['powershell', LONG_INLINE.slice(0, 1_000)],
    ]),
  },
  {
    // The same test's linux case: the long inline command on bash with Node's platform `linux`.
    name: 'script-file-transport-linux',
    test: 'scripts/shellhardening/script-transport.slow.test.mjs',
    mocks: true,
    run(tree, work, mock) {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const bash = ({ command }) => ({ command, analysisCommand: command, resolvedSpec: { shell: '/bin/bash', shellArg: '-lc', shellType: 'posix' } });
      return recordScriptFileTransport(tree, work, mock, [['posix', LONG_INLINE]], bash);
    },
  },
  {
    // script-transport.slow.test.mjs 'PowerShell filter plan preserves the producer native exit code' and '... leaves
    // pipelines nested in a group unwrapped': each command through the whole tool on Windows PowerShell, the text the shell
    // is handed (with or without the producer-exit tee) and the result of a clean exit.
    name: 'filter-plan',
    test: 'scripts/shellhardening/script-transport.slow.test.mjs',
    mocks: true,
    async run(tree, work, mock) {
      const seen = await mockShell(tree, mock, { stdout: '', stderr: '', exitCode: 0, signal: null }, { preflight: powershellPreflight });
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
      const commands = [
        "$t = Get-Content a.cs -Raw; ([regex]::Matches($t,'(\\w+)\\s*(?:\\(|=)') | % { $_.Groups[1].Value }) -join ','",
        'try { git status | Select-String main } catch { $_ }',
        'foreach ($f in $files) { $n = 1; Get-Content $f | Select-String x }',
        '@(Get-ChildItem | Select-Object -First 3).Count',
        '$x = 1; git log --oneline | Select-Object -First 3',
        'node -e "process.exit(7)" 2>&1 | Select-String impossible',
      ];
      const cases = [];
      for (const command of commands) {
        const result = normalizeToolEnvelope(await executeBashTool({ command }, work)).result;
        cases.push({ command, ran: seen.at(-1).command, result });
      }
      return { tmp: (await import('node:os')).tmpdir(), cases };
    },
  },
  {
    // script-transport.slow.test.mjs 'Windows executes an oversized PowerShell body with non-ASCII text', 'Windows executes
    // oversized node inline bodies through a script file', 'Windows fresh pwsh spawn reports parse errors in UTF-8 and keeps
    // exit codes' and 'Windows runs a grouped PowerShell pipeline as written': each command run live through the whole tool
    // (warm standby off, as the tests do). The parse-error command is not recorded: Node's fresh pwsh spawn feeds the script
    // through its UTF-8 bootstrap (`shell-warm-standby.mjs` STANDBY_BOOTSTRAP, `ParserError: <message>`), which Rust has not
    // ported (a difference, in the manifest).
    name: 'powershell-live',
    test: 'scripts/shellhardening/script-transport.slow.test.mjs',
    async run(tree, work) {
      process.env.MIXDOG_SHELL_WARM_STANDBY = '0';
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
      const commands = [
        `# ${'패딩'.repeat(9000)}\nWrite-Output '장문-전송-정상'`,
        "Write-Output '한글-정상'",
        'exit 3',
        `node -e '${`const slash = "\\\\"; /*${'x'.repeat(35_000)}*/ console.log("long-inline-ok")`}'`,
        "$t = 'private int Alpha; internal void Beta('; ([regex]::Matches($t,'(\\w+)\\s*(?:\\(|;)') | % { $_.Groups[1].Value }) -join ','",
      ];
      const cases = [];
      for (const command of commands) {
        const r = normalizeToolEnvelope(await executeBashTool({ command, timeout_ms: 10_000 }, work));
        cases.push({ command, success: r.explicitSuccess === true, result: r.result });
      }
      return { cases };
    },
  },
  {
    // script-transport.slow.test.mjs 'command text reaches the shell byte-identical': each body run through Node's
    // execShellCommand on Git Bash (`-lc`), as the test's runShellCase does.
    name: 'bash-byte-identity',
    test: 'scripts/shellhardening/script-transport.slow.test.mjs',
    async run(tree, work) {
      const { execShellCommand } = await load(tree, `${T}/shell-command.mjs`);
      const shell = 'C:\\Program Files\\Git\\bin\\bash.exe';
      const bodies = [
        'cat <<EOF\nbody & text\nEOF',
        "cat <<$'EOF'\nsleep 1 &\nEOF",
        'echo $((1 << 2))',
        "echo '((' ; cat <<EOF\nsleep 1 &\nEOF",
        'printf "%s\\n" "a & b"',
      ];
      const cases = [];
      for (const command of bodies) {
        const r = await execShellCommand({ shell, shellArg: '-lc', command, env: process.env, cwd: work, timeoutMs: 20_000, backgroundOnTimeout: false });
        cases.push({ command, exitCode: r.exitCode, stdout: r.stdout });
      }
      return { shell, cases };
    },
  },
  {
    // integration.live.test.mjs, its three tests: each command run live through the whole tool (pwsh, as the tests' host
    // shell): the findstr miss, the failed producer under a filter, and `git diff --quiet` in a dirty repo (its cwd).
    name: 'integration-live',
    test: 'scripts/shellhardening/integration.live.test.mjs',
    async run(tree, work) {
      process.env.MIXDOG_SHELL_WARM_STANDBY = '0';
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
      const { spawnSync } = await import('node:child_process');
      const { writeFileSync } = await import('node:fs');
      const dir = join(work, 'repo');
      mkdirSync(dir);
      const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      // The host's autocrlf would add a line-ending warning to stderr; the test's premise is the bare exit.
      git(['config', 'core.autocrlf', 'false']);
      writeFileSync(join(dir, 'f.txt'), 'one\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'init']);
      writeFileSync(join(dir, 'f.txt'), 'two\n');
      const runs = [
        { command: "'aaa' | findstr zzz; exit $LASTEXITCODE", inRepo: false },
        { command: `node -e 'process.stdout.write("producer-failed"); process.exit(7)' 2>&1 | Select-String impossible`, timeout_ms: 10_000, inRepo: false },
        { command: 'git diff --quiet', inRepo: true },
      ];
      const cases = [];
      for (const { inRepo, ...input } of runs) {
        const r = normalizeToolEnvelope(await executeBashTool(input, inRepo ? dir : work));
        cases.push({ input, inRepo, result: r.result });
      }
      return { cases };
    },
  },
  {
    // shell-output-silence.test.mjs, its first two tests, each on a job of its own as the tests do: a running shell task whose
    // streams wrote `x\n` at the given minute, its silence note (`shellTaskSilenceNote`) and its progress digest
    // (`readShellTaskOutput` digest) read at the given minute, in the tests' order. Later output appends (the tests rewrite
    // the same bytes and move the mtime; a live stream only grows). The third test and the fourth are not recorded (manifest).
    name: 'output-silence',
    test: `${B}/shell-output-silence.test.mjs`,
    async run(tree, work) {
      const { shellTaskSilenceNote } = await load(tree, `${B}/lib/shell-output-silence.mjs`);
      const { readShellTaskOutput } = await load(tree, `${B}/lib/shell-task-output.mjs`);
      const { registerBackgroundTask } = await load(tree, 'src/runtime/shared/background-tasks.mjs');
      const { appendFileSync, utimesSync } = await import('node:fs');
      const MIN = 60_000;
      const warnMs = 10 * MIN;
      const base = Date.now() - 3_600_000;
      const job = (name, script) => {
        const paths = { stdout_path: join(work, `${name}.out.log`), stderr_path: join(work, `${name}.err.log`) };
        const steps = [];
        const output = (stream, minute) => {
          const path = paths[`${stream}_path`];
          appendFileSync(path, 'x\n');
          utimesSync(path, new Date(base + minute * MIN), new Date(base + minute * MIN));
          steps.push({ output: stream, minute });
        };
        output('stdout', 0);
        output('stderr', 0);
        const task = registerBackgroundTask({
          taskId: `job_${name}`,
          startedAtMs: base,
          surface: 'shell',
          operation: 'shell',
          label: 'slow test',
          context: { callerSessionId: 'sess_silence' },
          meta: { stdout: paths.stdout_path, stderr: paths.stderr_path },
        });
        const note = (minute) => steps.push({ note: minute, text: shellTaskSilenceNote(task, { now: base + minute * MIN, warnMs }) });
        const digest = (minute) =>
          steps.push({ digest: minute, text: readShellTaskOutput(task, paths, { digest: true, now: base + minute * MIN, silenceWarnMs: warnMs }) });
        script({ output, note, digest });
        return { name, steps };
      };
      const jobs = [
        job('quiet', ({ note, digest }) => {
          digest(9);
          digest(12);
          note(12);
        }),
        job('reset', ({ output, note, digest }) => {
          note(12);
          output('stderr', 11);
          note(12);
          digest(12);
          note(22);
        }),
      ];
      return { warnMs, jobs };
    },
  },
  {
    // display-command.test.mjs: a piped PowerShell command started in the background runs wrapped and keeps the caller's text
    // as its label.
    name: 'display-command',
    test: `${B}/bash-tool/display-command.test.mjs`,
    mocks: true,
    async run(tree, work, mock) {
      const seen = await mockShell(tree, mock, { stdout: '', stderr: '', exitCode: 0, signal: null }, {
        preflight: ({ command }) => ({
          command,
          analysisCommand: command,
          resolvedSpec: { shell: 'powershell.exe', shellArg: '-Command', shellArgs: [], shellType: 'powershell' },
        }),
      });
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const original = 'npm test 2>&1 | Select-String fail';
      await executeBashTool({ command: original, background: true }, work);
      return { command: original, ran: seen[0].command, tmp: (await import('node:os')).tmpdir(), displayCommand: seen[0].displayCommand };
    },
  },
  {
    // failure-taxonomy.test.mjs 'WMIC rewrite note follows the leading shell failure marker': a wmic process query rewritten to
    // PowerShell that exits 1 with no output, through the whole tool (the real preflight on this Windows host).
    name: 'wmic-note',
    test: 'scripts/shellhardening/failure-taxonomy.test.mjs',
    mocks: true,
    async run(tree, work, mock) {
      const seen = await mockShell(tree, mock, { stdout: '', stderr: '', exitCode: 1, signal: null });
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
      const { classifyToolFailure } = await load(tree, 'src/runtime/agent/orchestrator/agent-trace-format.mjs');
      const command = 'wmic process get name,processid';
      const result = normalizeToolEnvelope(await executeBashTool({ command }, work));
      return { command, ran: seen[0].command, timeoutMs: seen[0].timeoutMs, result: result.result, failureClass: classifyToolFailure(result.result, 'shell') };
    },
  },
  {
    // failure-taxonomy.test.mjs 'asynchronous ENOENT spawn errors remain shell tool failures': a shell program that does not
    // exist, run through the whole tool (Node's real spawn), its result. `<WORK>` is the recorder's work dir.
    name: 'spawn-enoent',
    test: 'scripts/shellhardening/failure-taxonomy.test.mjs',
    mocks: true,
    async run(tree, work, mock) {
      const shell = join(work, 'mixdog-missing-shell.exe');
      mock.module(url(tree, `${B}/bash-tool/command-preflight.mjs`), {
        namedExports: {
          prepareShellCommand: ({ command }) => ({
            command,
            analysisCommand: command,
            resolvedSpec: { shell, shellArg: '-Command', shellArgs: [], shellType: 'powershell' },
          }),
        },
      });
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
      const command = 'echo unreachable';
      const result = normalizeToolEnvelope(await executeBashTool({ command, timeout_ms: 1000 }, work)).result;
      return { command, result: result.split(work).join('<WORK>') };
    },
  },
  {
    // failure-taxonomy.test.mjs 'shell failure rendering preserves actual signals and runtime kill causes': each process end of
    // the test (its `_shellFailureStatus` input) as the result of a Windows PowerShell run through the whole tool, the tool's
    // whole text, and the status detail the test asserts on.
    name: 'failure-status',
    test: 'scripts/shellhardening/failure-taxonomy.test.mjs',
    mocks: true,
    async run(tree, work, mock) {
      let answer;
      await mockShell(tree, mock, () => answer, { preflight: powershellPreflight });
      const { executeBashTool, _shellFailureStatus } = await load(tree, `${B}/bash-tool.mjs`);
      const { ExecResult } = await load(tree, `${T}/shell-command.mjs`).catch(() => ({}));
      const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
      const ends = [
        { name: 'signal', end: { signal: 'SIGKILL' } },
        { name: 'cancellation', end: { signal: 'SIGTERM', killed: true, killCause: 'cancellation' } },
        { name: 'timeout', end: { signal: 'SIGTERM', killed: true, timedOut: true, killCause: 'timeout' } },
        { name: 'output-capture-error', end: { killed: true, killCause: 'output-capture-error', outputCaptureError: 'disk full' } },
        { name: 'output-limit', end: { signal: 'SIGKILL', killed: true, killCause: 'output-limit' } },
      ];
      const cases = [];
      for (const { name, end } of ends) {
        const fields = { stdout: '', stderr: '', exitCode: null, taskId: 'test', ...end };
        if (fields.outputCaptureError) fields.outputCaptureError = new Error(fields.outputCaptureError);
        answer = fields;
        const result = normalizeToolEnvelope(await executeBashTool({ command: 'x', timeout_ms: 500 }, work)).result;
        const status = _shellFailureStatus(ExecResult ? new ExecResult(fields) : fields, 500).statusDetail;
        cases.push({ name, end, result, status });
      }
      return { cases };
    },
  },
  {
    // failure-process.slow.test.mjs 'cancellation racing with auto-background promotion is returned as cancelled': the test's
    // run (its racing abort signal, a 25 ms hold, cmd's 20 s ping) through the whole tool, Node's real execShellCommand under
    // the tool's call; the tool's text and the run's end.
    name: 'cancel-race',
    test: 'scripts/shellhardening/failure-process.slow.test.mjs',
    mocks: true,
    async run(tree, work, mock) {
      const { spawnSync } = await import('node:child_process');
      // The test's own call, in a host of its own (this one mocks the module for the tool): its end, as JSON.
      const script = `
        import ${JSON.stringify(url(tree, `${T}/lib/isolated-test-env.mjs`))};
        const { execShellCommand } = await import(${JSON.stringify(url(tree, `${T}/shell-command.mjs`))});
        const controller = new AbortController();
        const racingSignal = new Proxy(controller.signal, {
          get(target, property) {
            if (property === 'aborted' && String(new Error().stack || '').includes('_autoBackground') && !target.aborted) controller.abort();
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const r = await execShellCommand({
          shell: process.env.ComSpec || 'cmd.exe', shellArg: '/c', command: 'ping 127.0.0.1 -n 20 > nul', env: process.env,
          cwd: process.cwd(), timeoutMs: 5000, abortSignal: racingSignal, autoBackgroundMs: 25, backgroundOnTimeout: false,
        });
        const fields = ['stdout', 'stderr', 'exitCode', 'signal', 'killed', 'killCause', 'timedOut', 'backgrounded'];
        process.stdout.write('@@end ' + JSON.stringify(Object.fromEntries(fields.map((k) => [k, r[k] ?? null]))));
        process.exit(0);
      `;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: work, encoding: 'utf8', timeout: 60_000 });
      const end = JSON.parse(run.stdout.split('@@end ')[1]);
      // That end through the whole tool (Windows PowerShell, the tool's command a sleep no direct-exe spawn takes).
      const command = 'Write-Output racing; Start-Sleep 20';
      await mockShell(tree, mock, () => ({ ...end }), { preflight: powershellPreflight });
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
      const result = normalizeToolEnvelope(await executeBashTool({ command }, work)).result;
      return { command, end, result };
    },
  },
  {
    // foreground-artifact-lifecycle.test.mjs, its first and third tests: a killed foreground command whose tree settles later,
    // through the whole tool with only execution and the invocation plan scripted. Recorded per test: whether the hoisted
    // script (the tee capture) exists when the call has returned, its content, and whether it exists once the tree settled;
    // for the tee, whether the result carries the capture's diagnostic. The second test is `artifact-host-exit`.
    name: 'artifact-lifecycle',
    test: `${B}/bash-tool/foreground-artifact-lifecycle.test.mjs`,
    mocks: true,
    async run(tree, work, mock) {
      const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
      let result = null;
      let invocation = null;
      let teePlan = null;
      mock.module(url(tree, `${T}/shell-command.mjs`), {
        namedExports: { execShellCommand: async (input) => ((invocation = input), result), stripAnsi: (text) => text },
      });
      mock.module(url(tree, `${B}/bash-tool/command-preflight.mjs`), { namedExports: { prepareShellCommand: posixPreflight } });
      mock.module(url(tree, `${B}/bash-tool/invocation-plan.mjs`), {
        namedExports: { planShellInvocation: async ({ command }) => ({ wrappedCommand: command, teePlan }) },
      });
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const flush = () => new Promise((r) => setImmediate(r));
      const killed = () => {
        let finish;
        const settled = new Promise((r) => (finish = r));
        return { result: { stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL', killed: true, settled }, finish };
      };
      const cases = [];
      {
        const k = killed();
        result = k.result;
        await executeBashTool({ command: 'node -e "console.log(1)"' }, work);
        const script = /"([^"]+)"\s*$/.exec(invocation.command)[1];
        await flush();
        const kept = existsSync(script);
        const content = readFileSync(script, 'utf8');
        k.finish();
        await flush();
        cases.push({ name: 'hoisted-script', command: 'node -e "console.log(1)"', keptWhileRunning: kept, content, keptAfterSettle: existsSync(script) });
      }
      {
        const teePath = join(work, 'producer.log');
        writeFileSync(teePath, 'producer diagnostic\n');
        const k = killed();
        result = k.result;
        teePlan = { teePath };
        const rendered = await executeBashTool({ command: 'node producer.js | Select-String missing' }, work);
        await flush();
        const kept = existsSync(teePath);
        k.finish();
        await flush();
        cases.push({
          name: 'tee-capture',
          command: 'node producer.js | Select-String missing',
          diagnosticShown: JSON.stringify(rendered).includes('producer diagnostic'),
          keptWhileRunning: kept,
          content: 'producer diagnostic\n',
          keptAfterSettle: existsSync(teePath),
        });
      }
      return { cases };
    },
  },
  {
    // foreground-artifact-lifecycle.test.mjs 'a deferred hoisted script is removed at host exit when its tree never settles':
    // the test's own host script (a killed command whose tree never settles, then the host exits), whether the hoisted
    // script exists after the host exited.
    name: 'artifact-host-exit',
    test: `${B}/bash-tool/foreground-artifact-lifecycle.test.mjs`,
    async run(tree, work) {
      const { execFileSync } = await import('node:child_process');
      const { existsSync } = await import('node:fs');
      const u = (rel) => JSON.stringify(url(tree, rel));
      const script = `
      import ${u(`${T}/lib/isolated-test-env.mjs`)};
      import { mock } from 'node:test';
      let invocation;
      mock.module(${u(`${T}/shell-command.mjs`)}, { namedExports: {
        execShellCommand: async (input) => {
          invocation = input;
          return { stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL', killed: true, settled: new Promise(() => {}) };
        },
        stripAnsi: (text) => text,
      } });
      mock.module(${u(`${B}/bash-tool/command-preflight.mjs`)}, { namedExports: {
        prepareShellCommand: ({ command }) => ({ command, analysisCommand: command, resolvedSpec: { shellType: 'posix' } }),
      } });
      mock.module(${u(`${B}/bash-tool/invocation-plan.mjs`)}, { namedExports: {
        planShellInvocation: async ({ command }) => ({ wrappedCommand: command, teePlan: null }),
      } });
      const { executeBashTool } = await import(${u(`${B}/bash-tool.mjs`)});
      await executeBashTool({ command: 'node -e "console.log(1)"' }, process.cwd());
      process.stdout.write(/"([^"]+)"\\s*$/.exec(invocation.command)?.[1] || '');
      process.exit(0);
    `;
      const out = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', '--input-type=module', '-e', script], {
        cwd: work,
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const path = String(out).trim();
      return { command: 'node -e "console.log(1)"', hoisted: path !== '', keptAfterHostExit: path !== '' && existsSync(path) };
    },
  },
  {
    // queued-tee-lifecycle.test.mjs: a backgrounded run's tee capture (Node's queued run, which has no job id until it runs)
    // after 10 s of the run, and after the run settled.
    name: 'queued-tee',
    test: `${B}/bash-tool/queued-tee-lifecycle.test.mjs`,
    async run(tree, work, mock) {
      const { existsSync, writeFileSync } = await import('node:fs');
      const { renderBackgroundedResult } = await load(tree, `${B}/bash-tool/backgrounded-result.mjs`);
      const flush = () => new Promise((r) => setImmediate(r));
      mock.timers.enable({ apis: ['setTimeout'] });
      const teePath = join(work, 'producer.log');
      writeFileSync(teePath, 'queued producer output');
      let finish;
      const settled = new Promise((r) => (finish = r));
      renderBackgroundedResult({
        result: { backgrounded: true, settled, stdout: '', stderr: '' },
        command: 'node producer.js | Select-String missing',
        cwd: work,
        options: {},
        startedAtMs: Date.now(),
        teePlan: { teePath },
        stdout: '',
        stderr: '',
      });
      mock.timers.tick(10_000);
      await flush();
      const kept = existsSync(teePath);
      finish();
      await flush();
      mock.timers.reset();
      return { command: 'node producer.js | Select-String missing', keptWhileRunning: kept, keptAfterSettle: existsSync(teePath) };
    },
  },
  {
    // shell-run-background-final.test.mjs: a child that exits while its promotion commits resolves with the final read (the
    // test's own scripted run), and that result through the whole tool (execution scripted to answer it): its text.
    name: 'background-final',
    test: `${T}/shell-run-background-final.test.mjs`,
    mocks: true,
    async run(tree, work, mock) {
      let result;
      await mockShell(tree, mock, () => result, { preflight: powershellPreflight });
      mock.module(url(tree, `${T}/lib/shell-run-background/promote-job.mjs`), {
        namedExports: {
          promoteWithRetry: async ({ run }) => {
            run.child.exitCode = 0;
            return { job: { jobId: 'job-1' } };
          },
          handOverLease: async () => {},
          killAfterFailedPromotion: () => {},
        },
      });
      const { createAutoBackground } = await load(tree, `${T}/lib/shell-run-background.mjs`);
      const reads = [];
      const taskOutput = {
        spilled: true,
        stdoutPath: 'out.log',
        stderrPath: 'err.log',
        stdoutFileSize: 5,
        stderrFileSize: 0,
        writeError: null,
        forceSpill() {},
        async getStdout(final = false) {
          reads.push(final);
          return final ? 'ok \uFFFD' : 'ok ';
        },
        async getStderr() {
          return '';
        },
      };
      const run = {
        taskOutput,
        abortSignal: null,
        child: { exitCode: null, signalCode: null },
        taskId: 'task-1',
        startMs: Date.now(),
        settled: false,
        autoBackgrounded: false,
        killed: false,
        timedOut: false,
        resolveResult: (value) => {
          result = value;
        },
        isResolved: () => result !== undefined,
      };
      createAutoBackground({ run, command: 'x', cwd: '.', promotedTimeoutMs: 0, backgroundDeadlineMs: 0 })({ reason: 'threshold' });
      for (let i = 0; i < 50 && !result; i++) await new Promise((r) => setTimeout(r, 10));
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
      const text = normalizeToolEnvelope(await executeBashTool({ command: 'x' }, work)).result;
      return { command: 'x', backgrounded: result.backgrounded, stdout: result.stdout, exitCode: result.exitCode, reads, result: text };
    },
  },
  {
    // guardians-background.slow.test.mjs 'host family comes from the real spawn executable, never from an argument shape':
    // Node's family for each spawn of the test.
    name: 'host-family',
    test: 'scripts/shellhardening/guardians-background.slow.test.mjs',
    async run(tree) {
      const { _shellFamilyForSpawn } = await load(tree, `${T}/shell-command.mjs`);
      const spawns = [
        { shell: 'C:/Program Files/PowerShell/7/pwsh.exe', shellArg: '-Command' },
        { shell: 'C:/Windows/System32/cmd.exe', shellArg: '/c' },
        { shell: '/bin/bash', shellArg: '-lc' },
        { shell: 'C:/Program Files/Git/bin/bash.exe', shellArgs: ['-lc'] },
        { shell: '/bin/zsh', shellArg: '-c' },
        { shell: '/bin/dash', shellArg: '-c' },
        { shell: '/bin/sh', shellArg: '-c' },
        { shellType: 'cmd', shell: 'pwsh.exe', shellArg: '-Command' },
        { shellType: 'powershell', shell: 'C:/Windows/System32/cmd.exe', shellArg: '/c' },
        { shell: '/usr/bin/env', shellArg: 'bash' },
        { shell: '/usr/bin/env', shellArg: '/c' },
        { shell: 'C:/tools/custom.exe', shellArgs: ['/c'] },
        { shellType: 'posix' },
        {},
      ];
      return { cases: spawns.map((spawn) => ({ spawn, family: _shellFamilyForSpawn(spawn) })) };
    },
  },
  {
    // guardians-background.slow.test.mjs 'a real auto-backgrounded command leaves through the background result path': the
    // test's command run live on pwsh through the whole tool with a 500 ms hold; its text (task id as <ID>).
    name: 'auto-background-live',
    test: 'scripts/shellhardening/guardians-background.slow.test.mjs',
    async run(tree, work) {
      process.env.MIXDOG_SHELL_WARM_STANDBY = '0';
      // The test's 500 ms hold races pwsh's start (whether `started` is out by then is timing); 5 s lets every run print it.
      const holdMs = 5000;
      process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = String(holdMs);
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const { killShellJob } = await load(tree, `${B}/shell-jobs.mjs`);
      const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
      const command = 'Write-Output started; Start-Sleep -Seconds 20';
      const session = { sessionId: 'sess_autobg_render', callerSessionId: 'sess_autobg_render' };
      const rendered = normalizeToolEnvelope(await executeBashTool({ command }, work, session)).result;
      const id = rendered.match(/\[task_id:\s*([^\]]+)\]/)?.[1] ?? rendered.match(/^task_id:\s*(\S+)/m)?.[1];
      if (id) killShellJob(id);
      return { command, holdMs, result: id ? rendered.split(id).join('<ID>') : rendered };
    },
  },
  {
    // guardians-background.slow.test.mjs, the pwsh entry of 'a command that leaves descendants running is observed and
    // cancellable' and '… whose descendants all exit reports a plain completion', and 'a finished command that left
    // descendants is tracked and cancelled through the task tool': live on pwsh through the whole shell tool, then `task
    // cancel` on the task it names; each text (task id as <ID>).
    name: 'descendants-live',
    test: 'scripts/shellhardening/guardians-background.slow.test.mjs',
    async run(tree, work) {
      process.env.MIXDOG_SHELL_WARM_STANDBY = '0';
      const { executeBashTool } = await load(tree, `${B}/bash-tool.mjs`);
      const { executeTaskTool } = await load(tree, `${B}/task-tool.mjs`);
      const { normalizeToolEnvelope } = await load(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
      const session = { sessionId: 'sess_descendants_tracked', callerSessionId: 'sess_descendants_tracked' };
      const detaching = 'Start-Process -NoNewWindow ping -ArgumentList "-n","30","127.0.0.1"';
      const finishing = 'Start-Sleep -Milliseconds 200';
      const left = normalizeToolEnvelope(await executeBashTool({ command: detaching }, work, session)).result;
      const id = left.match(/\[task_id:\s*([^\]]+)\]/)?.[1] ?? left.match(/^task_id:\s*(\S+)/m)?.[1];
      const cancelled = id ? String(await executeTaskTool({ action: 'cancel', task_id: id }, session)) : null;
      const plain = normalizeToolEnvelope(await executeBashTool({ command: finishing }, work, session)).result;
      const neutral = (text) => (id && text ? text.split(id).join('<ID>') : text);
      return { detaching, finishing, left: neutral(left), cancelled: neutral(cancelled), plain };
    },
  },
  {
    // guardians-background.slow.test.mjs 'a promoted non-zero command reports one consistent status on every surface': each
    // native detail of the test, its canonical status and each surface's (task status, completion notice, public result).
    // The detail is the run the replay makes: task `task-s1`, `npm test` started at the replay clock and ended 1.5 s later,
    // its captures under `<L>`.
    name: 'status-surfaces',
    test: 'scripts/shellhardening/guardians-background.slow.test.mjs',
    async run(tree, work) {
      const { buildShellCompletion, normalizeShellJobDetail, shellJobPublicTaskResult, shellJobTaskStatus } = await load(tree, `${B}/shell-jobs.mjs`);
      const { writeFileSync } = await import('node:fs');
      const l = join(work, 'l');
      mkdirSync(l);
      writeFileSync(join(l, 'task-s1.stdout.log'), 'running tests');
      writeFileSync(join(l, 'task-s1.stderr.log'), '3 failing');
      const native = {
        jobId: 'task-s1',
        status: 'failed',
        exitCode: 3,
        timedOut: false,
        killed: false,
        error: null,
        command: 'npm test',
        cwd: '<CWD>',
        startedAt: '2026-01-02T03:04:05.678Z',
        finishedAt: '2026-01-02T03:04:07.178Z',
        stdoutPath: join(l, 'task-s1.stdout.log'),
        stderrPath: join(l, 'task-s1.stderr.log'),
        stdoutPreview: 'running tests',
        stderrPreview: '3 failing',
      };
      const details = [
        ['nonzero', native],
        ['signal', { ...native, exitCode: null, signal: 'SIGSEGV' }],
        ['signal-with-code', { ...native, exitCode: 139, signal: 'SIGSEGV' }],
        ['failed-exit-0', { ...native, exitCode: 0 }],
        ['failed-no-exit', { ...native, exitCode: null }],
        ['timed-out', { ...native, timedOut: true, exitCode: 124 }],
        ['running', { ...native, status: 'running', exitCode: null }],
      ];
      const cases = details.map(([name, detail]) => {
        const canonical = normalizeShellJobDetail(detail);
        const completion = canonical.status === 'running' ? null : buildShellCompletion(canonical.jobId, canonical);
        return {
          name,
          detail,
          status: canonical.status,
          nativeStatus: canonical.nativeStatus,
          taskStatus: shellJobTaskStatus(canonical),
          completion: completion && { taskStatus: completion.taskStatus, body: completion.body, error: completion.error, result: completion.result },
          public: shellJobPublicTaskResult(canonical),
        };
      });
      return JSON.parse(JSON.stringify({ cases }).split(JSON.stringify(l).slice(1, -1)).join('<L>'));
    },
  },
];

/** Cases of the scenario tests' files not replayed, by file and test name, with why. */
const EXCLUDED = {
  'scripts/shellhardening/script-transport.slow.test.mjs': {
    "Windows fresh pwsh spawn reports parse errors in UTF-8 and keeps exit codes (its parse-error command)":
      "difference: Node's fresh pwsh spawn runs the script through its UTF-8 standby bootstrap and prints `ParserError: <message>`; Rust has no warm standby (assigned to the tools-mcp-shell work) and prints pwsh's own error in the console code page",
    'generic oversized PowerShell commands use a safe whole-script transport (both oversized commands)':
      "difference: Node runs the 30 KB `# padding` script from a .ps1 file (or inline when it names $PSScriptRoot) and answers its output; Rust's exec policy (`policy::exec` `classify` on the scanned target) does not return within 120 s, so the call never spawns",
  },
  'scripts/shellhardening/failure-taxonomy.test.mjs': {
    'apply_patch taxonomy separates parse, context, verification, path and resource guards': 'trace classification: replayed in mixdog-trace',
    'committed or uncertain patch writes outrank lock and permission detail': 'trace classification: replayed in mixdog-trace',
    'shell-quoted patch output stays a command exit, never a patch failure': 'trace classification: replayed in mixdog-trace',
    'shell failure rendering preserves actual signals and runtime kill causes (output-capture-error)':
      'difference: Rust keeps output in memory and has no capture file whose write can fail',
    'shell failure rendering preserves actual signals and runtime kill causes (output-limit)': 'difference: the Rust process manager has no output-limit kill',
    'asynchronous ENOENT spawn errors remain shell tool failures (recorded as spawn-enoent)':
      'difference: Node answers `[spawn failed]\\n\\nENOENT: <OS message> (os error 2)`; Rust answers `[spawn failed]\\n\\nshell program not found: <path>`',
    'asynchronous EACCES spawn errors remain shell tool failures':'not recordable here: the test needs a POSIX host (Node skips it on Windows, the recording host)',
    'tool-failures excludes session cancellations but retains real abort failures': 'gone: Node diagnostic script scripts/tool-failures.mjs',
    'tool-failures report separates patch failures from command exits and absorbed preflights': 'gone: Node diagnostic script scripts/tool-failures.mjs',
    'tool-failures reclassifies historical patch rows without rewriting the source log': 'gone: Node diagnostic script scripts/tool-failures.mjs',
  },
  'scripts/shellhardening/failure-process.slow.test.mjs': {
    'execShellCommand carries cancellation cause alongside process signal': 'replayed by the recording shell-cancelled-foreground (tools/shell)',
    'implicit test traces are isolated while ship failures remain queryable': "gone: Node's test-run trace mode",
    'cancellation racing with auto-background promotion is returned as cancelled (recorded as cancel-race)':
      'difference: Node rechecks the abort when the hold ends and answers the cancelled run; Rust picks whichever of hold end and cancellation its select polls first and can answer the background start',
  },
  [`${B}/shell-run-background-final.test.mjs`]: {
    'a command that exits as its hold ends answers the final read (recorded as background-final)':
      "difference: Node answers `[exit code: 0]` with the final read (the split UTF-8 tail as U+FFFD); Rust can promote before its collector takes the exit and answers the background start with `ok ` so far",
  },
  'scripts/shellhardening/guardians-background.slow.test.mjs': {
    'a command whose descendants all exit reports a plain completion (the finishing run of descendants-live)':
      "difference: Node answers `[exit code: 0]\\n\\n(no output)` (its process-table probe takes the console host as a witness, never a survivor); Rust's in-process manager looks at the job once when the root exits, so a console host still closing is reported as a descendant left running (the spawn helper waits EXIT_SETTLE first, the in-process survivor watch does not)",
    'Windows-sensitive Node re-execs keep their windows hidden': 'gone: source text of Node re-execs (Rust spawns with CREATE_NO_WINDOW)',
    'child guardians re-exec Electron as Node without forwarding secrets': 'gone: no guardian process (job objects end the tree with its owner)',
    'command-scoped child guardians can stop without killing a reusable child': 'gone: no guardian process',
    'child guardians share one broker without coupling child lifetimes': 'gone: no guardian process',
    'a naturally exited child is removed from the parent guardian registry': 'gone: no guardian process',
    'host family comes from the real spawn executable, never from an argument shape':
      "difference (recorded as host-family): Node classifies the family by the executable; Rust's family is the runtime's `powershell` flag, which the daemon sets from the platform",
    'the background result block renders its warning slot in order': 'replayed by the recordings shell-survivors (with the warning) and tools/shell background start (without)',
    'git-bash and cmd entries of the two descendant tests': "difference: Rust's tool on Windows runs every command in the PowerShell family (the daemon's `powershell` flag); there is no Git Bash or cmd run of a command",
    'a promoted non-zero command reports one consistent status on every surface (exit 139 with SIGSEGV; failed with exit 0; failed with no exit)':
      'difference: a Rust process end is a code or a signal, never both, and there is no native failed status apart from the exit',
  },
  [`${B}/bash-tool/foreground-artifact-lifecycle.test.mjs`]: {
    'the first and third tests (recorded as artifact-lifecycle: hoisted script, tee capture of a killed tree)':
      "difference: Node removes them once the tree settles; Rust removes them through the maintenance lane with the cancelled call's token, which the lane refuses, so they stay in the temp dir",
    'a deferred hoisted script is removed at host exit when its tree never settles':
      'difference (recorded as artifact-host-exit): Rust removes a hoisted script when its command settles and has no exit hook; a tree that never settles leaves it in the temp dir',
  },
  [`${B}/bash-tool/completed-result-survivors.test.mjs`]: {
    'the folder reservation handed to survivors is released once they are gone':
      'difference: Node holds a per-command folder reservation until the survivors are gone; Rust has no per-command reservation (a worktree change is refused while any shell job of the session runs, survivors tasks included: mixdog-core-session)',
    'survivors a finished command left running do not hold the idle agent row waiting': "the Agents row's waiting state: not the exec module (agent pool progress)",
  },
  [`${T}/lib/shell-run-spawn.test.mjs`]: {
    'a startup whose child termination is unconfirmed keeps the reservation until the child is gone':
      'difference: no per-command folder reservation in Rust; a spawn abandoned at startup is killed by the process manager (spawn/manager.rs)',
    'a failed startup whose killed root leaves a descendant keeps the reservation until it is gone': 'difference: as above; the job object ends the whole tree',
  },
  [`${B}/shell-output-silence.test.mjs`]: {
    'an unreadable capture file means unknown silence, never a warning from the other stream': 'difference: Rust reads silence from output held in memory; no capture file can fail',
    'agent status shows the waited job tool silence and flags a hung one in the diagnostic': "the agent tool's status: mixdog-agent",
  },
};

async function child(args) {
  const tree = resolve(args.get('tree'));
  const work = resolve(args.get('work'));
  // What the Node tests import first: every user-data path under the scenario's own directory.
  await import(url(tree, `${T}/lib/isolated-test-env.mjs`));
  const scenario = SCENARIOS.find((s) => s.name === args.get('child'));
  const { mock } = await import('node:test');
  const record = await scenario.run(tree, work, mock);
  process.stdout.write(`\n@@record ${JSON.stringify(record)}\n`);
  process.exit(0);
}

async function parent(args) {
  const { FIXTURES_ROOT, commitStage, exactProductIdentity, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
  const { recorderProvenance } = await import('./lib/provenance.mjs');
  const { withJob } = await import('./lib/process-job.mjs');
  const tree = resolveTree(args);
  const identity = exactProductIdentity(tree, NODE_COMMIT);
  const workRoot = resolve(args.get('work') ?? (() => { throw new Error('--work <temp dir> is required'); })());
  mkdirSync(workRoot, { recursive: true });
  const only = args.get('only') ?? null;
  const scenarios = SCENARIOS.filter((s) => !only || s.name === only);
  if (!scenarios.length) throw new Error(`no scenario named ${only}`);
  const records = {};
  for (const scenario of scenarios) {
    const work = mkdtempSync(join(workRoot, `${scenario.name}-`));
    const env = { ...process.env, TEMP: work, TMP: work, TMPDIR: work };
    const flags = ['--experimental-test-module-mocks', '--no-warnings'];
    const run = await withJob(scenario.name, (job) =>
      job.run(scenario.name, process.execPath, [...flags, fileURLToPath(import.meta.url), '--child', scenario.name, '--tree', tree, '--work', work], { cwd: work, env, ms: SCENARIO_MS }),
    );
    if (run.timedOut) throw new Error(`${scenario.name}: no record within ${SCENARIO_MS} ms\n${run.stderr}`);
    const line = run.stdout.split('\n').find((l) => l.startsWith('@@record '));
    if (run.code !== 0 || !line) throw new Error(`${scenario.name}: exit ${run.code}\n${run.stdout}\n${run.stderr}`);
    records[scenario.name] = { test: scenario.test, ...JSON.parse(line.slice('@@record '.length)) };
  }
  if (only) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }
  const finalDir = join(FIXTURES_ROOT, 'exec-cases');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), { note: `Node's shell tool at ${NODE_COMMIT}, per scenario of ${RECORDER}`, platform: process.platform, scenarios: records });
  writeSetManifest(stage, {
    set: 'exec-cases',
    recorder: RECORDER,
    command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}> --work <temp dir>`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url),
      scenarios: SCENARIOS.map((s) => ({ name: s.name, test: s.test })),
      compared: {
        'deadline-plan':
          'every field of every plan, through the shell tool (a quiet process its manager ends at its run limit): the spawn run limit is backgroundDeadlineMs (background tasks on) or timeout (off), and timeout + promotedTimeoutMs when a deadline is split; the call ends at autoBackgroundMs moved to the background when that comes before timeout, else at timeout promoted as promoteAtTimeout says, else never on its own',
        'spawn-env': "both tests through the shell tool: the child's whole env per daemon env (<WORK> is the replay's directory), the daemon env unchanged, and the launcher files written",
        'display-command': 'the whole executed script (the tee token as <T>, its temp dir as <TMP>) and the task label',
        'script-file-transport': 'through the shell tool on the recorded spec: the whole text the shell is handed (the hoisted path as <FILE>), the hoisted file read when the shell starts, the whole result',
        'script-file-transport-linux': 'the same on bash with Node platform linux; Rust carries the command to bash in MIXDOG_SHELL_SCRIPT, which is the text compared',
        'filter-plan': 'through the shell tool: the whole executed script (tee token <T>, temp dir <TMP>) and the whole result',
        'powershell-live': 'the whole result text of each live run on pwsh',
        'spawn-enoent': 'not replayed: a difference (see excluded)',
        'failure-status': 'the whole result for the signal, cancellation and timeout ends',
        'cancel-race': 'not replayed: a difference (see excluded)',
        'artifact-lifecycle': 'not replayed: a difference (see excluded)',
        'queued-tee': 'kept while the run lasts and after it settled; the Rust form of the run is a command moved to the background',
        'background-final': 'not replayed: a difference (see excluded)',
        'status-surfaces':
          "the whole completion notice (capture dir <L>; Rust writes the path with `/`, Node's path.join with `\\`, compared as the same file) and its status for the ends the Rust process manager reports; the running task's status in the task list",
        'auto-background-live':
          "the whole background text (task id <ID>, start time, log path and the hold's elapsed seconds as placeholders); recorded and replayed with a 5 s hold instead of the test's 500 ms, which races pwsh's start",
        'descendants-live':
          'the detaching run up to its start time (the live ping output after it is timing) and task cancel, whole. The finishing run is not replayed: a difference (see excluded)',
        'bash-byte-identity': "the exit and stdout of each body, run through Rust's bash transport on the recorded Git Bash. Node's case runs below the tool (execShellCommand), so the tool's `cat` read-tool note line is removed from the Rust result before comparing",
        'integration-live': 'the whole result text of each live run; the repo case runs in a repo the replay builds the same way',
        'output-silence':
          "the first two tests: each silence note against the job's task-list entry, each digest against the whole body of a task wait. Not recorded: 'an unreadable capture file means unknown silence…' (a difference: Rust reads silence from the output it received, held in memory, and has no capture file to fail) and 'agent status shows the waited job tool silence…' (the agent tool's status, mixdog-agent)",
        'wmic-note': 'the result text and the hard limit; the executed text ends with the rewritten command (Rust puts its UTF-8 preamble before it in the same script, Node in execShellCommand)',
      },
      excluded: EXCLUDED,
    },
  });
  commitStage(stage, finalDir);
  console.log(`exec-cases: ${Object.keys(records).length} scenario(s)`);
}

const { parseArgs } = await import('./lib/common.mjs');
const args = parseArgs();
await (args.has('child') ? child(args) : parent(args));
