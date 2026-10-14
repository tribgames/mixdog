/**
 * The agent `export` action's request-independent parts: its host deadline
 * and the result text describing the written file.
 */
import { localizeProblemText } from './page-problems';

/** Host-side deadline of an agent `export`; the bridge client's is longer. */
export const EXPORT_DEADLINE_MS = 45_000;

/** Run `work` under one deadline of `limit` ms: when it passes, `work`'s
 *  signal aborts and nothing may be written. `work` calls `commit` right
 *  before its write: past the deadline that throws; before it, the write is
 *  no longer cut short. Errors carry `cwd`-relative paths only. */
export async function runWithExportDeadline<T>(
  limit: number,
  cwd: string,
  work: (signal: AbortSignal, commit: () => void) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timedOut = () => new Error(`export timed out after ${Math.round(limit / 1000)}s; no file was written`);
  let timer: NodeJS.Timeout | undefined;
  let committed = false;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (committed) return;
      controller.abort();
      reject(timedOut());
    }, limit);
  });
  const commit = () => {
    if (controller.signal.aborted) throw timedOut();
    committed = true;
    clearTimeout(timer);
  };
  const running = work(controller.signal, commit);
  // The race below reports the failure; this only keeps a rejection that
  // lands after the deadline from going unhandled.
  running.catch(() => {});
  try {
    return await Promise.race([running, expired]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(localizeProblemText(message, [cwd]));
  } finally {
    clearTimeout(timer);
  }
}

/** The result line of a written export: where, what and how it was made. */
export function exportedText(
  tabId: string,
  version: number | undefined,
  rel: string,
  format: 'png' | 'pdf',
  data: Buffer,
  how: string
): string {
  const size =
    format === 'png' && data.length >= 24 && data.toString('latin1', 1, 4) === 'PNG'
      ? `${data.readUInt32BE(16)}×${data.readUInt32BE(20)} px, `
      : '';
  const kb = data.length < 1024 ? `${data.length} B` : `${(data.length / 1024).toFixed(1)} KB`;
  return `Exported tab ${tabId}${version === undefined ? '' : ` v${version}`} to ${rel} (${format}, ${size}${kb}; ${how}).`;
}
