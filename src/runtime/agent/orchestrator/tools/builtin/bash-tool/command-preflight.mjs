import { maybeRewriteWmicProcessCommand } from '../../shell-policy.mjs';
import { checkExecPolicyMessage } from '../../bash-policy-scan.mjs';
import { preflightPowerShellHygiene } from '../shell-analysis.mjs';
import { resolveShellFor } from '../shell-runtime.mjs';
import { formatShellToolFailure } from './result-format.mjs';

// Policy + shell-specific rewrites before any shell dispatch. Returns either
// `{ failure }` (a formatted tool failure) or the command to run with the
// resolved shell spec and the wmic rewrite (if any).
export function prepareShellCommand(args) {
  // Run hard-block policy before any shell dispatch.
  const rawCmd = String(args && args.command != null ? args.command : '');
  if (rawCmd) {
    const policyBlock = checkExecPolicyMessage(rawCmd);
    if (policyBlock) return { failure: formatShellToolFailure(policyBlock) };
  }
  let command = args.command;
  if (!command) return { failure: formatShellToolFailure('command is required') };

  // Resolve the configured default shell up front so shell-type-specific
  // handling (PS-only wmic rewrite, PS UTF-8 prefix) can gate on it.
  const resolvedSpec = resolveShellFor('default');
  if (!resolvedSpec) return { failure: formatShellToolFailure('No supported system shell was found.') };

  // wmic→PowerShell rewrite is PowerShell-only; never mangle a command bound
  // for bash. wmic is a Windows-only tool, so the rewrite was already dead
  // code on POSIX hosts; the gate just makes that explicit.
  const wmicRewrite = resolvedSpec.shellType === 'powershell' ? maybeRewriteWmicProcessCommand(command) : null;
  if (wmicRewrite?.error) return { failure: formatShellToolFailure(wmicRewrite.error) };
  if (wmicRewrite?.command) command = wmicRewrite.command;

  // PowerShell hygiene preflight (Windows PS-only; POSIX no-op): losslessly
  // rewrite MSYS `/x/…` drive paths and reject invalid PowerShell syntax
  // (`$PID=` reassignment, `&&` on PS 5.1). Dedicated-tool routing belongs in
  // the tool description, not command-name execution blocks.
  const psHygiene = preflightPowerShellHygiene(command, {
    shellType: resolvedSpec.shellType,
    shellName: resolvedSpec.shell,
  });
  if (psHygiene.block) return { failure: formatShellToolFailure(psHygiene.block) };
  command = psHygiene.command;

  const execPolicyBlock = checkExecPolicyMessage(command);
  if (execPolicyBlock) return { failure: formatShellToolFailure(execPolicyBlock) };
  return { command, resolvedSpec, wmicRewrite };
}
