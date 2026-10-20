import { open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isGitTimeout } from './git-runner';

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
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Identical concurrent reads (several desktop windows and a phone polling one
 * repository) share their git processes, yet no caller is answered by a scan
 * that began before it asked: a caller arriving while a read runs waits for it
 * and joins the ONE follow-up read every such caller shares. N concurrent
 * callers cost at most two reads instead of N.
 */
export function sharedRead<A extends unknown[], R>(
  keyOf: (...args: A) => string,
  read: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  const lanes = new Map<string, { current: Promise<R>; next?: Promise<R> }>();
  const start = (key: string, args: A): Promise<R> => {
    const lane: { current: Promise<R>; next?: Promise<R> } = { current: read(...args) };
    lanes.set(key, lane);
    const settle = (): void => {
      if (lanes.get(key) === lane && !lane.next) lanes.delete(key);
    };
    lane.current.then(settle, settle);
    return lane.current;
  };
  return (...args: A): Promise<R> => {
    const key = keyOf(...args);
    const lane = lanes.get(key);
    if (!lane) return start(key, args);
    lane.next ??= lane.current.then(
      () => start(key, args),
      (error: unknown) => {
        // A read cut off at its deadline means the repository is wedged: a
        // follow-up would wait the whole deadline again and leave one more hung
        // git behind, so joined callers share the timeout. Later callers start fresh.
        if (!isGitTimeout(error)) return start(key, args);
        if (lanes.get(key) === lane) lanes.delete(key);
        throw error;
      }
    );
    return lane.next;
  };
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
    return `${[
      `diff --git a/${path} b/${path}`,
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n')}\n`;
  } catch {
    return '';
  }
}
