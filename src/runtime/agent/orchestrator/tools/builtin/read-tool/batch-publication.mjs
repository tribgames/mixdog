/**
 * Keep coalesced child observations private until the caller's exact windows
 * have been restored. A fresh child may outlive the batch's original cache
 * generation; retain that child's lease, never renew the whole batch.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { canPublishReadCache, runReadCachePublication } from '../cache-layers.mjs';
import { fileVersion, sameFileVersion } from '../file-version.mjs';
import { mergeReadRanges } from '../read-ranges.mjs';

// Streamed reads have numbered rows but no total-line footer. Prefer the
// rows themselves so smart-elided gaps never become delivered evidence.
export function renderedBatchReadRanges(body) {
  if (typeof body !== 'string') return [];
  const rows = [...body.matchAll(/^(\d+)[\t│→]/gm)]
    .map((match) => Number(match[1]))
    .filter((line) => Number.isSafeInteger(line) && line > 0)
    .map((line) => ({ startLine: line, endLine: line }));
  if (rows.length) return mergeReadRanges(rows);
  const footer = /\[lines\s+(\d+)-(\d+)\s+of\s+\d+/.exec(body);
  return footer ? mergeReadRanges([{ startLine: Number(footer[1]), endLine: Number(footer[2]) }]) : [];
}

function hasRenderedLines(body) {
  return renderedBatchReadRanges(body).length > 0;
}

export async function runBatchReadSnapshotPublication(executeChildBuiltinTool, helpers, run) {
  const tasks = [];
  const records = [];
  const corrections = new Map();
  let closed = false;

  function capture(task, fullPath, st, scope, meta) {
    if (closed) return;
    const identity = fileVersion(st);
    const record = {
      fullPath,
      scope: scope ?? null,
      identity,
      ranges: mergeReadRanges(meta?.ranges),
      isCurrent: () => false,
      publish: () => {},
      release: () => {},
      done: Promise.resolve(),
    };
    task.records.push(record);
    records.push(record);
    // Acquiring a new lease must not rehabilitate an already stale producer.
    if (!identity || !canPublishReadCache(fullPath)) return;
    const decision = Promise.withResolvers();
    record.publish = (replacement = meta) => decision.resolve(replacement);
    record.release = () => decision.resolve(null);
    record.done = runReadCachePublication(fullPath, async () => {
      record.isCurrent = AsyncLocalStorage.bind(() => canPublishReadCache(fullPath));
      const selected = await decision.promise;
      if (selected) helpers._recordReadSnapshot(fullPath, identity, scope, selected);
    });
  }

  const executeChild = async (name, args, workDir, options = {}) => {
    if (name !== 'read' || (args.mode && args.mode !== 'full')) {
      return executeChildBuiltinTool(name, args, workDir, options);
    }
    const task = {
      entry: args,
      fullPath: helpers.resolveAgainstCwd(args.path, workDir),
      records: [],
      body: null,
    };
    tasks.push(task);
    task.body = await executeChildBuiltinTool(name, args, workDir, {
      ...options,
      _readSnapshotRecorder: (...snapshot) => capture(task, ...snapshot),
    });
    return task.body;
  };
  const snapshotHelpers = {
    ...helpers,
    _filterReadSnapshotRanges: (entry, fullPath, scope, ranges) => {
      const task = tasks.find((task) => task.entry === entry);
      const observation = task?.records.findLast(
        (record) => record.fullPath === fullPath && record.scope === (scope ?? null)
      );
      // A numbered row may end halfway through its content at the byte cap.
      // Only this slot's producer can certify complete lines; another read of
      // the same path must not authorize hashing this slot's partial text.
      return mergeReadRanges(
        ranges.flatMap((range) =>
          (observation?.ranges ?? []).map((complete) => ({
            startLine: Math.max(range.startLine, complete.startLine),
            endLine: Math.min(range.endLine, complete.endLine),
          }))
        )
      );
    },
    _recordReadSnapshot: (fullPath, _st, scope, meta) => {
      corrections.set(fullPath, { scope: scope ?? null, meta });
    },
  };

  try {
    const result = await run(executeChild, snapshotHelpers);
    // reject_partial refuses the entire payload: staged bodies were not
    // delivered, so none of their snapshots may become session evidence.
    if (result?.isError === true || (typeof result === 'string' && helpers.classifyResultKind(result) === 'error')) {
      return result;
    }
    for (const [fullPath, correction] of corrections) {
      const delivered = tasks.filter((task) => task.fullPath === fullPath && hasRenderedLines(task.body));
      const observations = delivered.map((task) =>
        task.records.findLast((record) => record.fullPath === fullPath && record.scope === correction.scope)
      );
      // Never combine different versions or bless stale/missing observations.
      // The eventual recorder rechecks the retained lease after all awaits.
      if (
        observations.length &&
        observations.every(
          (record) => record?.isCurrent() && sameFileVersion(record.identity, observations[0].identity)
        )
      ) {
        observations[0].publish(correction.meta);
      }
    }
    // Rich media/binary results have no line slices. Preserve their original
    // evidence, still under the producer's lease rather than the batch's.
    for (const task of tasks) {
      if (
        hasRenderedLines(task.body) ||
        task.body?.isError === true ||
        (typeof task.body === 'string' && helpers.classifyResultKind(task.body) === 'error')
      )
        continue;
      for (const record of task.records) {
        if (!corrections.has(record.fullPath)) record.publish();
      }
    }
    for (const record of records) record.release();
    await Promise.all(records.map((record) => record.done));
    return result;
  } finally {
    // Promise.all in the dispatcher may reject while other children remain
    // active. Late captures then become no-ops and cannot leak a held lease.
    closed = true;
    for (const record of records) record.release();
    await Promise.allSettled(records.map((record) => record.done));
  }
}
