import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Fixed-size counters only; no coordinates, titles, text, or session identity. */
export function createCursorDiagnostics(save: (value: object) => Promise<void>) {
  const counts: Record<string, number> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = Promise.resolve();
  const startedAt = new Date().toISOString();
  const snapshot = () => ({ version: 1, startedAt, updatedAt: new Date().toISOString(), counts: { ...counts } });
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const value = snapshot();
    writing = writing.then(() => save(value)).catch(() => {});
    return writing;
  };
  return {
    record(stage: string, amount = 1) {
      if (!/^[a-z_]{1,48}$/.test(stage) || !Number.isSafeInteger(amount) || amount < 0 || amount > 10000) return;
      if (!(stage in counts) && Object.keys(counts).length >= 32) return;
      counts[stage] = Math.min(1_000_000, (counts[stage] || 0) + amount);
      if (!timer) {
        timer = setTimeout(() => { void flush(); }, 500);
        timer.unref?.();
      }
    },
    snapshot, flush,
  };
}

let path = '';
const diagnostics = createCursorDiagnostics(async value => {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
});
export function configureCursorDiagnostics(filePath: string) { path = filePath; }
export const recordCursorDiagnostic = diagnostics.record;
