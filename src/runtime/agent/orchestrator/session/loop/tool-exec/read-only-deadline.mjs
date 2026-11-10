/**
 * read-only-deadline.mjs — bound a read-only I/O tool call: after the
 * deadline the call is aborted, but the tool keeps a short grace window to
 * hand back the partial output it already collected.
 */
const READ_ONLY_IO_TOOL_NAMES = new Set([
  'read',
  'head',
  'tail',
  'wc',
  'summary',
  'hex',
  'grep',
  'glob',
  'find',
  'find_files',
  'list',
  'tree',
]);
const READ_ONLY_IO_TIMEOUT_MS = 20_000;
// After the deadline aborts the call, the tool gets this long to hand back
// whatever it already collected (rg/native search stream partial lines and
// close on abort). Throwing the whole call away discarded work the tool had
// in hand and forced a blind retry.
const READ_ONLY_IO_PARTIAL_GRACE_MS = 1_500;

function readOnlyIoTimeoutMs() {
  const raw = String(process.env.MIXDOG_IO_TOOL_TIMEOUT_MS ?? '').trim();
  if (raw === '0') return 0;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? Math.max(1, Math.floor(configured)) : READ_ONLY_IO_TIMEOUT_MS;
}

function readOnlyIoDeadlineNotice(name, timeoutMs) {
  return `\n[warning] read-only I/O tool "${name}" hit the ${timeoutMs}ms deadline; PARTIAL results shown — narrow the scope (path, glob, more specific pattern, smaller limit) for the complete set.`;
}

function withReadOnlyIoDeadlineNotice(value, name, timeoutMs) {
  const notice = readOnlyIoDeadlineNotice(name, timeoutMs);
  if (typeof value === 'string') return value.length ? `${value}${notice}` : value;
  // Tool envelopes keep their structure; only the model-visible text grows.
  if (value && typeof value === 'object' && typeof value.result === 'string') {
    return { ...value, result: `${value.result}${notice}` };
  }
  return value;
}

export async function runReadOnlyIoWithDeadline(name, parentSignal, run) {
  if (!READ_ONLY_IO_TOOL_NAMES.has(name)) return await run(parentSignal || null);
  const timeoutMs = readOnlyIoTimeoutMs();
  if (timeoutMs <= 0) return await run(parentSignal || null);
  const controller = new AbortController();
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  // `reject` is false for the deadline: aborting the tool must NOT settle the
  // outer race, or the grace window below could never collect the partial.
  const abortWith = (reason, reject = true) => {
    if (controller.signal.aborted) return;
    const error = reason instanceof Error ? reason : new Error(String(reason || `tool "${name}" aborted`));
    if (reject) rejectAbort(error);
    controller.abort(error);
  };
  const onParentAbort = () => abortWith(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });
  const timeoutError = new Error(
    `read-only I/O tool "${name}" timed out after ${timeoutMs}ms with no partial output; narrow the scope (path, glob, more specific pattern, smaller limit) and retry.`
  );
  timeoutError.code = 'READ_ONLY_IO_TIMEOUT';
  let deadlineReached = false;
  let signalDeadline;
  const deadline = new Promise((resolve) => {
    signalDeadline = resolve;
  });
  const timer = setTimeout(() => {
    deadlineReached = true;
    abortWith(timeoutError, false);
    signalDeadline();
  }, timeoutMs);
  let graceTimer = null;
  // Never rejects: the deadline branch must be able to inspect the outcome
  // instead of losing it to an already-settled race.
  const settled = Promise.resolve()
    .then(() => run(controller.signal))
    .then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );
  try {
    const first = await Promise.race([settled, aborted, deadline]);
    if (!deadlineReached && first) {
      if (first.ok) return first.value;
      throw first.error;
    }
    // Deadline fired: wait briefly for the aborted tool's own partial result.
    const graced = await Promise.race([
      settled,
      new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(null), READ_ONLY_IO_PARTIAL_GRACE_MS);
      }),
    ]);
    if (graced?.ok && graced.value != null && graced.value !== '') {
      return withReadOnlyIoDeadlineNotice(graced.value, name, timeoutMs);
    }
    throw timeoutError;
  } finally {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    parentSignal?.removeEventListener?.('abort', onParentAbort);
  }
}
