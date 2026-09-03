import { open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const GIT_METADATA_TTL_MS = 60_000;
export const DISPLAY_DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color'] as const;
export const UNTRACKED_STAT_CONCURRENCY = 8;

const UNTRACKED_STAT_PROBE_BYTES = 8 * 1024;
const UNTRACKED_STAT_MAX_BYTES = 8 * 1024 * 1024;

export function gitCacheKey(cwd: string): string {
  const normalized = resolve(cwd);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const fields = raw.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(fields[index]);
    if (!match) continue;
    let path = match[3];
    if (!path) {
      index += 2;
      path = fields[index] ?? '';
    }
    if (!path) continue;
    stats.set(path, {
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return stats;
}

export async function untrackedStat(cwd: string, path: string): Promise<number> {
  try {
    const handle = await open(join(cwd, path), 'r');
    try {
      const info = await handle.stat();
      if (info.size <= 0 || info.size > UNTRACKED_STAT_MAX_BYTES) return 0;
      const probe = Buffer.allocUnsafe(Math.min(info.size, UNTRACKED_STAT_PROBE_BYTES));
      const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
      if (probe.subarray(0, bytesRead).includes(0)) return 0;
      const text = await handle.readFile('utf8');
      if (!text) return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } finally {
      await handle.close();
    }
  } catch {
    return 0;
  }
}

export async function untrackedPatch(cwd: string, path: string): Promise<string> {
  try {
    const text = await readFile(join(cwd, path), 'utf8');
    if (!text || text.includes('\0')) return '';
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (!lines.length) return '';
    return [
      `diff --git a/${path} b/${path}`,
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n') + '\n';
  } catch {
    return '';
  }
}
