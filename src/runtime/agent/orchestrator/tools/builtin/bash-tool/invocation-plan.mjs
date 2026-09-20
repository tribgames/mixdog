import { wrapCommandWithSnapshot } from '../../shell-snapshot.mjs';
import { buildPowerShellFilterTeePlan } from '../shell-analysis.mjs';
import { normalizeErrorMessage } from '../path-diagnostics.mjs';
import { planDirectExeSpawn } from '../shell-direct-exe.mjs';
import { buildShellSpawnEnv } from './spawn-env.mjs';
import { formatShellToolFailure } from './result-format.mjs';

function prefixPowerShellUtf8(command) {
  const prefix =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8;';
  const text = String(command || '');
  return text.trimStart().startsWith(prefix) ? text : `${prefix}\n${text}`;
}

// How the command reaches the child: a direct exe spawn, PowerShell with the
// UTF-8 prefix (+ optional filter-tee rescue), or a POSIX bash/zsh snapshot
// wrapper delivered through the environment. Returns `{ failure }` when the
// snapshot wrapper cannot be built.
export async function planShellInvocation({ command, resolvedSpec, cwd }) {
  const { shell, shellArg, shellArgs, shellType } = resolvedSpec;
  const spawnEnv = buildShellSpawnEnv(cwd);
  const plan = {
    execShell: shell,
    execShellArg: shellArg,
    execShellArgs: shellArgs,
    wrappedCommand: command,
    execScript: null,
    directArgv: null,
    teePlan: null,
    spawnEnv,
  };
  const directPlan = planDirectExeSpawn(command, { shellType, cwd, pathValue: spawnEnv.PATH, env: spawnEnv });
  if (directPlan) {
    plan.execShell = directPlan.exe;
    plan.execShellArg = '';
    plan.execShellArgs = [];
    plan.directArgv = directPlan.argv;
    return plan;
  }
  // PowerShell UTF-8 prefix is PS-only: the Windows Git Bash path
  // (shellType==='posix') must NOT receive it. Snapshot wrapper stays
  // POSIX-host-only for now — no snapshot for Windows Git Bash initially.
  if (process.platform === 'win32' && shellType === 'powershell') {
    // Filter-swallow rescue: tee the unfiltered producer stream of an
    // exactly-recognized filter pipeline so a failing run can attach the
    // original output tail in THIS call instead of returning `[exit code: N]`
    // + `(no output)`. Any ambiguity yields a null plan and the command runs
    // untouched.
    try {
      plan.teePlan = buildPowerShellFilterTeePlan(command);
    } catch {
      plan.teePlan = null;
    }
    plan.wrappedCommand = prefixPowerShellUtf8(plan.teePlan ? plan.teePlan.command : command);
    return plan;
  }
  if (process.platform !== 'win32' && (shell.includes('bash') || shell.includes('zsh'))) {
    try {
      plan.wrappedCommand = await wrapCommandWithSnapshot(shell, command);
    } catch (wrapErr) {
      return {
        failure: formatShellToolFailure(
          `shell snapshot wrapper failed — ${normalizeErrorMessage(wrapErr instanceof Error ? wrapErr.message : String(wrapErr))}`
        ),
      };
    }
    // Deliver the script through the environment, not argv. `bash -c
    // '<script>'` publishes the entire command text in the child's
    // /proc/<pid>/cmdline, so any `-f` (full-cmdline) process matcher built
    // from that same text matches the wrapper running it. Measured: `pkill -f
    // "sshd -D"` SIGTERM'd its own shell 7 ms in, and `while pgrep -f
    // install_rstan.R; do sleep 15; done` could never exit because pgrep kept
    // finding the loop's own wrapper — a silent infinite wait, not an error.
    //
    // `eval` is the same parser on the same shell: quoting, heredocs, `set -e`,
    // traps, exit status and stdin all behave as under -c. Only the argv
    // exposure changes. `?` (not `:?`) fires solely when the variable never
    // arrived, so an empty command stays the no-op it is today.
    spawnEnv.MIXDOG_SHELL_SCRIPT = plan.wrappedCommand;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    plan.execScript = 'eval "${MIXDOG_SHELL_SCRIPT?mixdog: shell script was not delivered to the child}"';
  }
  return plan;
}
