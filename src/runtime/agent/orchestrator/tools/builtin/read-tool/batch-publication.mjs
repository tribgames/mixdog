/**
 * Keep coalesced child observations private until the caller's exact windows
 * have been restored. A fresh child may outlive the batch's original cache
 * generation; retain that child's lease, never renew the whole batch.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { canPublishReadCache, runReadCachePublication } from '../cache-layers.mjs';
import { fileVersion, sameFileVersion } from '../file-version.mjs';

function hasRenderedLines(body) {
  return typeof body === 'string' && /\[lines\s+\d+-\d+\s+of\s+\d+/.test(body);
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
    _recordReadSnapshot: (fullPath, _st, scope, meta) => {
      corrections.set(fullPath, { scope: scope ?? null, meta });
    },
  };

  try {
    const result = await run(executeChild, snapshotHelpers);
    for (const [fullPath, correction] of corrections) {
      const delivered = tasks.filter((task) => task.fullPath === fullPath && hasRenderedLines(task.body));
      const observations = delivered.map((task) => task.records.findLast(
        (record) => record.fullPath === fullPath && record.scope === correction.scope
      ));
      // Never combine different versions or bless stale/missing observations.
      // The eventual recorder rechecks the retained lease after all awaits.
      if (observations.length && observations.every((record) =>
        record?.isCurrent() && sameFileVersion(record.identity, observations[0].identity)
      )) {
        observations[0].publish(correction.meta);
      }
    }
    // Rich media/binary results have no line slices. Preserve their original
    // evidence, still under the producer's lease rather than the batch's.
    for (const task of tasks) {
      if (hasRenderedLines(task.body) || helpers.classifyResultKind(task.body) === 'error') continue;
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
