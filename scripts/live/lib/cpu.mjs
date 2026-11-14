// Whole-machine CPU load, sampled per platform: Windows CIM, Linux /proc/stat, macOS top. A platform or read that fails
// gives null (a missing reading never fails a run).
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Busy percentage between two readings of /proc/stat (idle + iowait count as idle), or null. */
export function linuxLoad(before, after) {
  const fields = (text) => {
    const line = String(text).split('\n').find((l) => l.startsWith('cpu '));
    return line ? line.trim().split(/\s+/).slice(1).map(Number) : null;
  };
  const a = fields(before);
  const b = fields(after);
  if (!a || !b || a.length < 5 || b.length < 5) return null;
  const sum = (f) => f.reduce((x, y) => x + y, 0);
  const idle = (f) => f[3] + f[4];
  const total = sum(b) - sum(a);
  if (!(total > 0)) return null;
  return Math.round(((total - (idle(b) - idle(a))) / total) * 1000) / 10;
}

/** Busy percentage from the last `CPU usage:` line of `top -l 2 -n 0` (the first is the since-boot average), or null. */
export function macLoad(text) {
  const lines = String(text).split('\n').filter((l) => /CPU usage:/.test(l));
  const m = /([\d.]+)%\s*idle/.exec(lines.at(-1) ?? '');
  return m ? Math.round((100 - Number(m[1])) * 10) / 10 : null;
}

/** One machine-wide reading in percent (about one second), or null. */
export async function cpuLoad(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const { stdout } = await exec(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'],
        { windowsHide: true, timeout: 30_000 }
      );
      const value = Number(stdout.trim());
      return Number.isFinite(value) ? value : null;
    }
    if (platform === 'linux') {
      const before = await readFile('/proc/stat', 'utf8');
      await sleep(1000);
      return linuxLoad(before, await readFile('/proc/stat', 'utf8'));
    }
    if (platform === 'darwin') {
      const { stdout } = await exec('top', ['-l', '2', '-n', '0', '-s', '1'], { timeout: 30_000 });
      return macLoad(stdout);
    }
  } catch {}
  return null;
}

/** A few readings spaced out, for a "before"/"after" record. */
export async function cpuSample(count = 3, gapMs = 1000) {
  const values = [];
  for (let i = 0; i < count; i += 1) {
    values.push(await cpuLoad());
    if (i + 1 < count) await sleep(gapMs);
  }
  const ok = values.filter((v) => Number.isFinite(v));
  return { at: new Date().toISOString(), values, mean: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null };
}
