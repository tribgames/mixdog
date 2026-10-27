// Complete copy of a task report whose model-visible notification was bounded.
// It outlives the in-memory task row (30 min TTL); the notification names it
// (`<output-file>` and the preview marker) for the `read` tool, and a restored
// card reads it back to show the whole report.
//
// With a known owning session the copy lives in that session's artifact
// directory (<data>/tool-results/<sessionId>/), which deleting the session
// purges; otherwise in <data>/task-reports/. The file name is the SHA-256 of
// task id and text, so distinct reports never share a file and the name proves
// the content.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { writeFileAtomicSync } from './atomic-file.mjs';
import { resolvePluginData } from './plugin-paths.mjs';
import { TASK_REPORT_LIMIT, boundTaskReport } from './task-notification-envelope.mjs';
import { toolResultsSessionDir } from './tool-results-dir.mjs';

const SPILL_NAME_RE = /^([0-9a-f]{64})\.txt$/;

const spillDigest = (taskId, text) => createHash('sha256').update(`${taskId}\0${text}`).digest('hex');

/** Writes `text` and returns its absolute path, or null when the write failed. */
export function spillTaskReport(taskId, text, sessionId = '') {
  const body = String(text);
  const dir = sessionId ? toolResultsSessionDir(sessionId) : join(resolvePluginData(), 'task-reports');
  const path = join(dir, `${spillDigest(taskId, body)}.txt`);
  try {
    // createOnly publishes a complete file atomically; an existing one is the
    // same report (the name is its digest).
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomicSync(path, body, { mode: 0o600, createOnly: true });
    }
    return path;
  } catch (err) {
    process.stderr.write(`[task-report] spill failed: id=${taskId} err=${err?.message || err}\n`);
    return null;
  }
}

/** The complete report a bounded notification's `<output-file>` holds, or null
 *  when it is not one of this module's spill files (wrong place or name, wrong
 *  digest for `taskId`) or cannot be read. */
export function readSpilledTaskReport(taskId, file) {
  try {
    const path = resolve(String(file || ''));
    const digest = SPILL_NAME_RE.exec(basename(path))?.[1];
    const fromData = relative(resolve(resolvePluginData()), path);
    if (!digest || !fromData || fromData.startsWith('..') || isAbsolute(fromData)) return null;
    if (!['task-reports', 'tool-results'].includes(fromData.split(/[\\/]/)[0])) return null;
    if (!statSync(path).isFile()) return null;
    const text = readFileSync(path, 'utf8');
    return spillDigest(taskId, text) === digest ? text : null;
  } catch {
    return null;
  }
}

/** The report as the model sees it: `{ result, outputFile }`. Within the limit
 *  it is unchanged (`outputFile` null); longer, it is saved in full and replaced
 *  by a bounded preview, `outputFile` naming the copy. If the copy cannot be
 *  saved the report is delivered whole rather than cut. */
export function boundReportForModel(taskId, report, sessionId = '') {
  const text = String(report ?? '');
  if (text.length <= TASK_REPORT_LIMIT) return { result: text, outputFile: null };
  const outputFile = spillTaskReport(taskId, text, sessionId);
  if (!outputFile) return { result: text, outputFile: null };
  return { result: boundTaskReport(text, { pointer: `full report: read ${outputFile}` }), outputFile };
}
