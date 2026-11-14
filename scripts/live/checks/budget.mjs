// mixdogd's own resident memory and CPU while the instance is idle and while it serves browser snapshots (CU frames, AX
// trees, DOMSnapshot) and protocol reads. The numbers go into the run output; a limit is checked only where the owner
// names one (--max-rss-mb, --max-cpu-percent, percent of one core), otherwise the check records and passes.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { browserCommand } from '../lib/core-client.mjs';
import { parseLiveArgs } from '../lib/paths.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const name = 'mixdogd memory and cpu budget';

/** Seconds out of ps `cputime` ([[dd-]hh:]mm:ss[.ff]). */
export function parsePsCpu(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** `{ rssBytes, cpuSeconds }` of a process, or null when it cannot be read (gone, or no tool on the platform). */
export async function processStats(pid, platform = process.platform) {
  const id = Number(pid);
  try {
    if (platform === 'win32') {
      const { stdout } = await exec(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-Command', `$p = Get-Process -Id ${id} -ErrorAction Stop; [pscustomobject]@{ rss = $p.WorkingSet64; cpu = $p.TotalProcessorTime.TotalSeconds } | ConvertTo-Json -Compress`],
        { windowsHide: true, timeout: 30_000 }
      );
      const row = JSON.parse(stdout);
      return { rssBytes: Number(row.rss), cpuSeconds: Number(row.cpu) };
    }
    if (platform === 'linux') {
      const status = await readFile(`/proc/${id}/status`, 'utf8');
      const stat = await readFile(`/proc/${id}/stat`, 'utf8');
      const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[11]) + Number(fields[12]);
      if (!Number.isFinite(rssKb) || !Number.isFinite(ticks)) return null;
      return { rssBytes: rssKb * 1024, cpuSeconds: ticks / 100 };
    }
    const { stdout } = await exec('ps', ['-o', 'rss=,cputime=', '-p', String(id)]);
    const [rss, cpu] = stdout.trim().split(/\s+/);
    const cpuSeconds = parsePsCpu(cpu);
    return Number.isFinite(Number(rss)) && cpuSeconds !== null ? { rssBytes: Number(rss) * 1024, cpuSeconds } : null;
  } catch {
    return null;
  }
}

/** Samples `pid` every `everyMs` for `ms` while `during(deadline)` (if any) runs; returns RSS and CPU (percent of one core). */
export async function measure(pid, { ms, everyMs = 1000, during, stats = processStats }) {
  const first = await stats(pid);
  if (!first) throw new Error(`pid ${pid} cannot be read`);
  const startedAt = Date.now();
  const load = during ? during(startedAt + ms).catch((error) => ({ error: error.message })) : null;
  const rss = [first.rssBytes];
  let last = first;
  while (Date.now() - startedAt < ms) {
    await sleep(everyMs);
    const s = await stats(pid);
    if (!s) throw new Error(`pid ${pid} went away while it was measured`);
    rss.push(s.rssBytes);
    last = s;
  }
  const wallS = (Date.now() - startedAt) / 1000;
  const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
  return {
    samples: rss.length,
    wallSeconds: Math.round(wallS * 10) / 10,
    rssStartMb: mb(first.rssBytes),
    rssPeakMb: mb(Math.max(...rss)),
    rssMeanMb: mb(rss.reduce((a, b) => a + b, 0) / rss.length),
    cpuPercentOfOneCore: Math.round(((last.cpuSeconds - first.cpuSeconds) / wallS) * 1000) / 10,
    load: load ? await load : null,
  };
}

/** Browser snapshots and protocol reads until `deadline`; counts what answered and what failed. */
async function exercise(env, deadline) {
  let ok = 0;
  let failed = 0;
  let firstError = null;
  const call = async (fn) => {
    try {
      await fn();
      ok += 1;
    } catch (error) {
      failed += 1;
      firstError ??= error instanceof Error ? error.message : String(error);
    }
  };
  await call(() => browserCommand(env.core, 'navigate', { url: env.fixtures.url('/form') }));
  while (Date.now() < deadline) {
    await call(() => browserCommand(env.core, 'snapshot', {}));
    await call(() => env.core.request('notify/state', {}));
  }
  return { ok, failed, firstError };
}

export async function run({ env, idleMs = 10_000, loadMs = 30_000, args = parseLiveArgs(process.argv.slice(2)) }) {
  const pid = env.coreCheck?.pid;
  if (!pid) throw new Error('no core pid to measure');
  const idle = await measure(pid, { ms: idleMs });
  const loaded = await measure(pid, { ms: loadMs, during: (deadline) => exercise(env, deadline) });
  const line = (label, m) => `${label}: rss peak ${m.rssPeakMb} MB (mean ${m.rssMeanMb}), cpu ${m.cpuPercentOfOneCore}% of one core over ${m.wallSeconds} s`;
  const load = loaded.load;
  const detail = `${line('idle', idle)}; ${line('browser snapshots', loaded)}; ${load?.ok ?? 0} calls answered, ${load?.failed ?? 0} failed${load?.firstError ? ` (first: ${load.firstError.slice(0, 200)})` : ''}`;
  const maxRss = Number(args['max-rss-mb']);
  const maxCpu = Number(args['max-cpu-percent']);
  const limited = Number.isFinite(maxRss) || Number.isFinite(maxCpu);
  const over = [];
  if (Number.isFinite(maxRss) && Math.max(idle.rssPeakMb, loaded.rssPeakMb) > maxRss) over.push(`rss peak above ${maxRss} MB`);
  if (Number.isFinite(maxCpu) && loaded.cpuPercentOfOneCore > maxCpu) over.push(`cpu above ${maxCpu}% of one core`);
  if (load?.error) throw new Error(`the load phase broke: ${load.error}; ${detail}`);
  if (over.length) throw new Error(`${over.join(', ')}; ${detail}`);
  return `${detail}${limited ? '' : ' (no limit given: recorded only)'}`;
}
