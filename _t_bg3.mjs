import { execShellCommand } from './src/runtime/agent/orchestrator/tools/shell-command.mjs';
import { resolveShellFor } from './src/runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs';
import { isAutobackgroundingAllowed } from './src/runtime/agent/orchestrator/tools/builtin/shell-analysis.mjs';
import { peekShellJob } from './src/runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs';

const p = (c) => isAutobackgroundingAllowed(c, 'posix');
console.log('sudo -u nobody', p('sudo -u nobody sleep 5'),
  'setpriv', p('setpriv --reuid user sleep'),
  'nice', p('nice -n 10 sleep 3'),
  'plain', p('echo start; while :; do :; done'),
  'sudo npm', p('sudo npm run build'));

const spec = await resolveShellFor({});
const { shell, shellArg, shellArgs, shellType } = spec;
const busy = shellType === 'powershell'
  ? 'Write-Output start; $e=(Get-Date).AddSeconds(6); while((Get-Date) -lt $e){}; Write-Output done'
  : 'echo start; e=$((SECONDS+6)); while [ $SECONDS -lt $e ]; do :; done; echo done';
const nap = shellType === 'powershell' ? 'Start-Sleep -Seconds 6' : 'sleep 6';
async function run(tag, cmd, t, allow) {
  const r = await execShellCommand({ shell, shellArg, shellArgs, command: cmd, env: process.env,
    cwd: process.cwd(), timeoutMs: t, backgroundOnTimeout: allow });
  console.log(tag, 'bg=', r.backgrounded, 'timedOut=', r.timedOut);
  return r;
}
const a = await run('A promote', busy, 1500, isAutobackgroundingAllowed(busy, shellType));
if (a.jobId) { await new Promise(r=>setTimeout(r,6500)); console.log('A final', peekShellJob(a.jobId)?.status); }
await run('B sleep', nap, 1200, isAutobackgroundingAllowed(nap, shellType));
process.exit(0);
