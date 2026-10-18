// Bounded, single-flight, cancellable provider catalog work, shared by the
// registry's catalog refreshes and the session runtime's shared catalog.
//
// - Deadline: a caller waits at most `timeoutMs` and then gets an ETIMEDOUT
//   error entry instead of the provider's answer, so one hung provider cannot
//   hold a catalog read or a startup/forced refresh.
// - Cancellation: on that deadline the operation's AbortSignal fires; a
//   provider whose listModels honors `{ signal }` stops its work there.
// - Single flight: per provider at most one operation is pending in this
//   process. A caller that finds one of its own kind joins it (with its own
//   deadline); one that finds the other kind (a refresh vs a model list)
//   waits for it inside its deadline before starting its own. An operation
//   leaves the table only when the underlying work settles, not when a
//   caller gives up, so repeated timed-out reads never pile up work; once an
//   operation overran one deadline, later callers fail fast on it instead of
//   each waiting out another deadline, until it settles.
// - Generations: one auth/account generation spans refreshes and lists alike
//   (bumpProviderCatalogGeneration). Work of the other kind pending from an
//   older generation, or from an older provider instance, never blocks or
//   fails a caller of the newer one: that caller starts afresh. Same-kind
//   work is never joined across generations, instances or a caller-supplied
//   `epoch` (the catalog revision a list belongs to) either, unless it
//   stalled (below).
// - Stalled work: an operation that overran its deadline (its signal fired)
//   and still has not settled ignores cancellation. Until it settles, that
//   provider name is not asked again for the same kind, not by a newer
//   generation, epoch or provider instance: callers get an ETIMEDOUT entry
//   marked `stalled` at once. Otherwise every account change, catalog
//   revision or registry rebuild would leave one more never-ending call
//   behind in the provider. Superseded calls can only overlap inside one
//   deadline window, before any of them stalls.
import { clearProviderCatalogFailures, recordProviderCatalogOutcome } from './catalog-failures.mjs';

export const PROVIDER_CATALOG_TIMEOUT_MS = 4_000;

/** name -> the latest op started for that provider (either kind). */
const pendingOps = new Map();
/** `${kind}\0${name}` -> Set of the unsettled ops of that kind, of any
 *  generation, epoch or provider instance; emptied sets are removed. */
const runningOps = new Map();
/** `${kind}\0${name}` -> sequence number of the latest op started of that kind. */
const latestOpSeq = new Map();
let opSeq = 0;
let generation = 0;

const runKey = (name, kind) => `${kind}\0${name}`;

/** Opens a new auth/account generation for every provider's catalog work. */
export function bumpProviderCatalogGeneration() {
  generation += 1;
  // Failures of the previous account say nothing about the new one.
  clearProviderCatalogFailures();
}

/** Provider names with catalog work still pending (diagnostics and tests). */
export function pendingProviderCatalogOps() {
  return [...pendingOps.keys()];
}

/** `{ name, kind }` of every operation that ignored its deadline's abort and
 *  is still unsettled (diagnostics and tests). */
export function stalledProviderCatalogOps() {
  return [...runningOps.values()]
    .flatMap((ops) => [...ops])
    .filter((op) => op.timedOut)
    .map(({ name, kind }) => ({ name, kind }));
}

const isStalled = (name, kind) => [...(runningOps.get(runKey(name, kind)) || [])].some((op) => op.timedOut);

function startOp(name, provider, kind, run, epoch, opGeneration) {
  const controller = new AbortController();
  const settled = Promise.resolve()
    .then(() => run(controller.signal))
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    );
  const seq = ++opSeq;
  const op = { name, provider, kind, epoch, generation: opGeneration, seq, controller, settled, done: false };
  const key = runKey(name, kind);
  latestOpSeq.set(key, seq);
  const running = runningOps.get(key) || new Set();
  running.add(op);
  runningOps.set(key, running);
  pendingOps.set(name, op);
  void settled.then(() => {
    op.done = true;
    if (pendingOps.get(name) === op) pendingOps.delete(name);
    running.delete(op);
    if (running.size === 0 && runningOps.get(key) === running) runningOps.delete(key);
  });
  return op;
}

function timeoutError(message) {
  const error = new Error(message);
  error.code = 'ETIMEDOUT';
  return error;
}

/** Resolves `{ value }`, `{ error }`, or `{ error, timedOut: true }`; never rejects.
 *  The outcome is also kept as the provider's latest catalog failure (or
 *  recovery) for views that explain an empty list (catalog-failures.mjs),
 *  but only while it is current: a caller of a superseded generation, or one
 *  answered by an op that a newer op of its kind replaced, publishes nothing. */
export async function boundedProviderCatalogOp(op) {
  const callerGeneration = generation;
  const answered = { op: null };
  const outcome = await runBoundedOp(op, callerGeneration, answered);
  const currentOp = !answered.op || latestOpSeq.get(runKey(op.name, op.kind)) === answered.op.seq;
  if (callerGeneration === generation && currentOp) recordProviderCatalogOutcome(op.name, outcome.error);
  return outcome;
}

async function runBoundedOp(
  { name, provider, kind, run, timeoutMs = PROVIDER_CATALOG_TIMEOUT_MS, epoch = 0 },
  callerGeneration,
  answered
) {
  let timer = null;
  let watched = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      const error = timeoutError(`provider "${name}" catalog ${kind} did not finish within ${timeoutMs}ms`);
      if (watched) {
        // Stalled until it settles: an op that honors the abort settles (and
        // leaves the table) a few microtasks later, one that ignores it stays.
        watched.timedOut = true;
        watched.controller.abort(error);
      }
      resolve({ error, timedOut: true });
    }, timeoutMs);
  });
  try {
    for (;;) {
      let op = pendingOps.get(name);
      const superseded =
        !op || op.provider !== provider || op.generation < callerGeneration || (op.kind === kind && op.epoch !== epoch);
      if (superseded) {
        if (isStalled(name, kind)) {
          const error = timeoutError(`provider "${name}" catalog ${kind} ignored its deadline and is still pending`);
          return { error, timedOut: true, stalled: true };
        }
        op = startOp(name, provider, kind, run, epoch, callerGeneration);
      } else if (op.timedOut) {
        // Already overran a deadline and still not settled: fail fast instead
        // of making every later caller wait out another deadline for it.
        const error = timeoutError(`provider "${name}" catalog ${op.kind} is still pending after its deadline`);
        return { error, timedOut: true };
      }
      watched = op;
      if (op.kind === kind) {
        answered.op = op;
        return await Promise.race([op.settled, deadline]);
      }
      const outcome = await Promise.race([op.settled.then(() => null), deadline]);
      if (outcome) return outcome;
    }
  } finally {
    clearTimeout(timer);
  }
}
