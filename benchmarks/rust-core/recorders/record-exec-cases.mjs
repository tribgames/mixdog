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
    // bash-tool-cwd-env.test.mjs: the model shell's env over a daemon env of `PATH=A;B`, with the launcher directory of this
    // process's runtime under a data dir of the recorder's work dir; the launcher files written there.
    name: 'launcher-path',
    test: `${B}/bash-tool-cwd-env.test.mjs`,
    async run(tree, work) {
      const dataDir = join(work, 'data');
      process.env.MIXDOG_DATA_DIR = dataDir;
      const { buildShellSpawnEnv } = await load(tree, `${B}/bash-tool.mjs`);
      const { skillLauncherDir, skillLauncherFiles, skillScriptRuntime } = await load(tree, 'src/runtime/shared/skill-script-runtime.mjs');
      const { readFileSync, existsSync } = await import('node:fs');
      const { delimiter } = await import('node:path');
      const runtime = skillScriptRuntime();
      const dir = skillLauncherDir(runtime, dataDir);
      const daemonPath = process.env.PATH;
      const daemonEnv = { PATH: ['A', 'B'].join(delimiter) };
      const env = buildShellSpawnEnv('C:\\x', daemonEnv);
      return {
        runtime: { platform: runtime.platform, interpreter: runtime.interpreter, entry: runtime.entry, electron: runtime.electron },
        dataDir,
        dir,
        daemonEnv,
        PATH: env.PATH,
        sessionCwd: env.MIXDOG_SESSION_CWD,
        daemonPathKept: process.env.PATH === daemonPath,
        files: skillLauncherFiles(runtime).map(({ name }) => ({ name, exists: existsSync(join(dir, name)), content: readFileSync(join(dir, name), 'utf8') })),
      };
    },
  },
  {
    // script-transport.slow.test.mjs 'PowerShell filter plan leaves pipelines nested in a group unwrapped' (and the producer-exit
    // plan of the test before it): whether a tee plan is made. The plan's own text carries a random token.
    name: 'filter-plan-groups',
    test: 'scripts/shellhardening/script-transport.slow.test.mjs',
    async run(tree) {
      const { buildPowerShellFilterTeePlan } = await load(tree, `${B}/shell-analysis.mjs`);
      const commands = [
        "$t = Get-Content a.cs -Raw; ([regex]::Matches($t,'(\\w+)\\s*(?:\\(|=)') | % { $_.Groups[1].Value }) -join ','",
        'try { git status | Select-String main } catch { $_ }',
        'foreach ($f in $files) { $n = 1; Get-Content $f | Select-String x }',
        '@(Get-ChildItem | Select-Object -First 3).Count',
        '$x = 1; git log --oneline | Select-Object -First 3',
        'node -e "process.exit(7)" 2>&1 | Select-String impossible',
      ];
      return { cases: commands.map((command) => ({ command, planned: buildPowerShellFilterTeePlan(command) !== null })) };
    },
  },
  {
    // script-transport.slow.test.mjs 'Windows executes an oversized PowerShell body with non-ASCII text' and 'Windows fresh
    // pwsh spawn reports parse errors in UTF-8 and keeps exit codes': each command run live through the whole tool (warm
    // standby off, as the test does). The test's parse-error command is not recorded: Node's fresh pwsh spawn feeds the
    // script through its UTF-8 bootstrap (`shell-warm-standby.mjs` STANDBY_BOOTSTRAP, `ParserError: <message>`), which Rust
    // has not ported, so Rust's text differs (reported, not committed).
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
      const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
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
    // shell-output-silence.test.mjs 'a running job quiet past the threshold…' and 'output on either stream resets the silence
    // clock': a running shell task whose streams last wrote at the given minute, read at the given minute.
    name: 'output-silence',
    test: `${B}/shell-output-silence.test.mjs`,
    async run(tree, work) {
      const { shellTaskSilenceNote } = await load(tree, `${B}/lib/shell-output-silence.mjs`);
      const { registerBackgroundTask } = await load(tree, 'src/runtime/shared/background-tasks.mjs');
      const { utimesSync, writeFileSync } = await import('node:fs');
      const MIN = 60_000;
      const warnMs = 10 * MIN;
      const base = Date.now() - 3_600_000;
      const paths = { stdout: join(work, 'out.log'), stderr: join(work, 'err.log') };
      const steps = [];
      const output = (stream, minute) => {
        writeFileSync(paths[stream], 'x\n');
        utimesSync(paths[stream], new Date(base + minute * MIN), new Date(base + minute * MIN));
        steps.push({ output: stream, minute });
      };
      output('stdout', 0);
      output('stderr', 0);
      const task = registerBackgroundTask({
        taskId: 'job_silence',
        startedAtMs: base,
        surface: 'shell',
        operation: 'shell',
        label: 'slow test',
        context: { callerSessionId: 'sess_silence' },
        meta: { stdout: paths.stdout, stderr: paths.stderr },
      });
      const read = (minute) => steps.push({ read: minute, note: shellTaskSilenceNote(task, { now: base + minute * MIN, warnMs }) });
      read(9);
      read(12);
      output('stderr', 11);
      read(12);
      read(22);
      return { warnMs, steps };
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
      return { command: original, wrapped: /__mixdogProducerExit/.test(seen[0].command), displayCommand: seen[0].displayCommand };
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
];

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
  const { recordingScripts } = await import('./lib/recording-scripts.mjs');
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
      ...recordingScripts([RECORDER]),
      scenarios: SCENARIOS.map((s) => ({ name: s.name, test: s.test })),
      compared: {
        'deadline-plan': 'autoBackgroundMs against the hold, and the run limit (backgroundDeadlineMs with background tasks on, timeout without) against the time limit. Rust has one run limit the process manager enforces and no separate foreground timeout: promotedTimeoutMs and promoteAtTimeout are not compared; a run limit at or below the hold being enforced instead of promoted is the real-process test a_real_command_over_its_time_limit_is_killed_with_nodes_text',
        'launcher-path': 'the launcher directory and files are compared for the recorded runtime and data dir; the shell PATH for the daemon env PATH=A;B',
        'filter-plan-groups': 'whether a plan is made; the plan text carries a random token',
        'powershell-live': 'the whole result text of each live run on pwsh',
        'bash-byte-identity': "the exit and stdout of each body, run through Rust's bash transport on the recorded Git Bash. Node's case runs below the tool (execShellCommand), so the tool's `cat` read-tool note line is removed from the Rust result before comparing",
        'integration-live': 'the whole result text of each live run; the repo case runs in a repo the replay builds the same way',
        'output-silence':"the warning at each read. Not recorded: the test's unreadable-capture case (a capture file that cannot be stat'd): Rust reads silence from the output it received, held in memory, and has no capture file to fail",
        'wmic-note': 'the result text and the hard limit; the executed text ends with the rewritten command (Rust puts its UTF-8 preamble before it in the same script, Node in execShellCommand)',
      },
    },
  });
  commitStage(stage, finalDir);
  console.log(`exec-cases: ${Object.keys(records).length} scenario(s)`);
}

const { parseArgs } = await import('./lib/common.mjs');
const args = parseArgs();
await (args.has('child') ? child(args) : parent(args));
