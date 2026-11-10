// Ends what a recording left behind. Started by record-call-tool.mjs right after it makes its profile folder: it waits for the recorder
// (pid) to be gone, then ends every process whose command line holds the profile path (the Node daemon's Postgres and its launcher; found by
// path, never by name) and removes the folder. It runs after the recorder's own last exit hook, so a file written by a hook that runs late
// does not bring the folder back, and it also covers a recorder that was killed and could run nothing.
// Usage: node sandbox-janitor.mjs <recorder pid> <profile folder>
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const [pid, sandbox] = [Number(process.argv[2]), process.argv[3]];
const deadline = Date.now() + 30 * 60_000;
const alive = () => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
while (alive()) {
  if (Date.now() > deadline) {
    console.error(`recorder ${pid} still running after 30 minutes; ${sandbox} left in place`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const list = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($env:REC_SANDBOX) } | ForEach-Object { $_.ProcessId }"],
  { env: { ...process.env, REC_SANDBOX: sandbox }, encoding: 'utf8', timeout: 30_000, windowsHide: true }
);
if (list.status !== 0) {
  console.error(`cannot list the processes of ${sandbox}: status ${list.status} ${list.error ?? list.stderr}`);
  process.exit(1);
}
let failed = false;
for (const id of list.stdout.split(/\s+/).filter(Boolean)) {
  if (Number(id) === process.pid) continue;
  // 128: the process was already gone with its parent's tree.
  const ended = spawnSync('taskkill', ['/T', '/F', '/PID', id], { stdio: 'ignore', timeout: 15_000, windowsHide: true });
  if (ended.status !== 0 && ended.status !== 128) {
    console.error(`cannot end pid ${id} of ${sandbox}: status ${ended.status} ${ended.error ?? ''}`);
    failed = true;
  }
}
try {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
} catch (error) {
  console.error(`cannot remove ${sandbox}: ${error.message}`);
  failed = true;
}
process.exit(failed ? 1 : 0);