/**
 * machine-tool.mjs — one-call machine status: CPU load (total + top
 * processes), memory (available/total + top processes), free space per drive
 * and, on request, the processes matching a name. One short sample, hard
 * 1.8 s deadline: whatever is not ready by then is reported as unavailable
 * instead of holding the call.
 */
import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';

export const MACHINE_DEADLINE_MS = 1800;
const CPU_SAMPLE_MS = 250;
const TOP_DEFAULT = 5;
const TOP_MAX = 20;
const MATCH_MAX = 25;
const PROCESS_NAME_MAX = 128;

const GB = 1024 ** 3;
const gb = (bytes) => `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1)} GB`;
const mb = (bytes) => `${Math.round(bytes / 1024 ** 2)} MB`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withDeadline = (promise, ms) => Promise.race([promise, delay(ms).then(() => null)]);

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : String(stdout))
    );
  });
}

const cpuTimes = () =>
  os.cpus().reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 }
  );

async function sampleTotalCpu() {
  const a = cpuTimes();
  await delay(CPU_SAMPLE_MS);
  const b = cpuTimes();
  const total = b.total - a.total;
  return total > 0 ? Math.round((100 * (total - (b.idle - a.idle))) / total) : 0;
}

// Windows: two Get-Process reads 250 ms apart inside ONE PowerShell, so the
// per-process CPU is a rate, not a lifetime average. Rows: pid, name, cpu s
// before, cpu s after, working set bytes; first row is the elapsed ms.
const WINDOWS_PROCESS_SCRIPT = [
  '$sw=[Diagnostics.Stopwatch]::StartNew()',
  '$a=@{};Get-Process|%{$a[$_.Id]=[double]$_.CPU}',
  `Start-Sleep -Milliseconds ${CPU_SAMPLE_MS}`,
  'Get-Process|%{"$($_.Id)`t$($_.ProcessName)`t$($a[$_.Id])`t$([double]$_.CPU)`t$($_.WorkingSet64)"}',
  '$sw.ElapsedMilliseconds',
].join(';');

async function windowsProcesses(timeout) {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCRIPT], timeout);
  if (!out) return null;
  const rows = out.trim().split(/\r?\n/);
  const elapsedSec = (Number(rows.pop()) || CPU_SAMPLE_MS) / 1000;
  const cores = os.cpus().length || 1;
  return rows.map((row) => {
    const [pid, name, before, after, memory] = row.split('\t');
    const used = Number(before) >= 0 && Number(after) >= 0 ? Number(after) - Number(before) : 0;
    return { pid: Number(pid), name, cpu: (100 * used) / elapsedSec / cores, memory: Number(memory) || 0 };
  });
}

// POSIX: one ps read; %cpu there is the kernel's own average, not a sample.
async function posixProcesses(timeout) {
  const out = await run('ps', ['-A', '-o', 'pid=,pcpu=,rss=,comm='], timeout);
  if (!out) return null;
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter(Boolean)
    .map(([, pid, cpu, rss, name]) => ({
      pid: Number(pid),
      name: name.replace(/^.*\//, ''),
      cpu: Number(cpu) / (os.cpus().length || 1),
      memory: Number(rss) * 1024,
    }));
}

async function windowsDrives() {
  const letters = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`);
  const rows = await Promise.all(
    letters.map((root) =>
      statfs(root).then(
        (s) => ({ root, free: s.bavail * s.bsize, total: s.blocks * s.bsize }),
        () => null
      )
    )
  );
  return rows.filter((row) => row && row.total > 0);
}

async function posixDrives(timeout) {
  const out = await run('df', ['-Pk'], timeout);
  if (!out) return null;
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 6 && cols[0].startsWith('/') && Number(cols[1]) > 0)
    .map((cols) => ({ root: cols.slice(5).join(' '), free: Number(cols[3]) * 1024, total: Number(cols[1]) * 1024 }));
}

const list = (rows, line) => (rows.length ? rows.map(line).join('\n') : '  none');
const procLine = (p) => `  ${p.name} (pid ${p.pid})  cpu ${p.cpu.toFixed(1)}%  mem ${mb(p.memory)}`;

/** The machine status text for `args` ({ top?, process? }). */
export async function executeMachineTool(args = {}) {
  const top = Math.min(Math.max(Math.trunc(Number(args.top)) || TOP_DEFAULT, 1), TOP_MAX);
  if (typeof args.process === 'string' && args.process.length > PROCESS_NAME_MAX) {
    return `Error: machine process must be at most ${PROCESS_NAME_MAX} characters (got ${args.process.length})`;
  }
  // Control characters would break the one-line echo below.
  const shownName = typeof args.process === 'string' ? args.process.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '';
  const filter = shownName.toLowerCase();
  const win = process.platform === 'win32';
  const [cpu, processes, drives] = await Promise.all([
    sampleTotalCpu(),
    withDeadline(win ? windowsProcesses(MACHINE_DEADLINE_MS - 200) : posixProcesses(MACHINE_DEADLINE_MS - 200), MACHINE_DEADLINE_MS),
    withDeadline(win ? windowsDrives() : posixDrives(MACHINE_DEADLINE_MS - 200), MACHINE_DEADLINE_MS),
  ]);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const lines = [
    `cpu: ${cpu}% busy of ${os.cpus().length} cores (${CPU_SAMPLE_MS} ms sample)`,
    `memory: ${gb(freeMem)} available of ${gb(totalMem)} (${Math.round((100 * (totalMem - freeMem)) / totalMem)}% used)`,
  ];
  if (processes) {
    lines.push(
      `top by cpu:\n${list([...processes].sort((a, b) => b.cpu - a.cpu).slice(0, top), procLine)}`,
      `top by memory:\n${list([...processes].sort((a, b) => b.memory - a.memory).slice(0, top), procLine)}`
    );
  } else {
    lines.push('processes: unavailable (no answer within the deadline)');
  }
  lines.push(
    drives
      ? `drives (free of total):\n${list(drives, (d) => `  ${d.root}  ${gb(d.free)} of ${gb(d.total)}`)}`
      : 'drives: unavailable (no answer within the deadline)'
  );
  if (filter && processes) {
    const matches = processes.filter((p) => p.name.toLowerCase().includes(filter));
    const shown = matches.sort((a, b) => b.cpu - a.cpu).slice(0, MATCH_MAX);
    const more = matches.length > shown.length ? `\n  … ${matches.length - shown.length} more` : '';
    lines.push(`processes matching "${shownName}" (${matches.length}):\n${list(shown, procLine)}${more}`);
  }
  return lines.join('\n');
}
