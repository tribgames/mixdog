// Loader hook of record-held-runs.mjs. The product files are untouched; two seams are the recorder's:
//  - session-runtime/agent-home-delivery.mjs is replaced by a module that only exports `deliverHeldRequest` (the one name
//    held-requests.mjs takes from it): the row a hold posts into the owner's home thread is recorded, not queued
//    (the delivery's own queue and home thread have their own recordings);
//  - human-gate/gate.mjs keeps every export, but `recordHumanDecision` runs one call after another in the order the calls
//    were made and every call is registered, so the recorder can await the audit writes the held layer starts without
//    awaiting (held-requests.mjs `settle`) by Node's own promises instead of a wait.
export async function load(url, context, nextLoad) {
  if (url.endsWith('/session-runtime/agent-home-delivery.mjs')) {
    const source = `export async function deliverHeldRequest(agentId, held) {
  (globalThis.__heldDeliveries ??= []).push({ agentId, held: structuredClone(held) });
  globalThis.__onHeldDelivery?.();
  // A scenario can make the home thread's queue slow: 'all' never persists a row, 'pending' never persists a pending row, and
  // 'pending-until-release' persists it once the script releases it. A delivery is recorded as persisted when it completes.
  const stall = globalThis.__stallDelivery;
  const slow = stall === 'all' || (held.status === 'pending' && (stall === 'pending' || stall === 'pending-until-release'));
  if (slow) {
    if (stall !== 'pending-until-release') return new Promise(() => {});
    await new Promise((release) => (globalThis.__releases ??= []).push(release));
  }
  (globalThis.__heldPersisted ??= []).push({ agentId, id: held.id, status: held.status });
  globalThis.__onHeldPersisted?.();
  return true;
}
`;
    return { format: 'module', source, shortCircuit: true };
  }
  if (url.endsWith('/human-gate/gate.mjs')) {
    const source = `import * as real from ${JSON.stringify(`${url}?real`)};
export * from ${JSON.stringify(`${url}?real`)};
let chain = Promise.resolve();
export const recordHumanDecision = (...args) => {
  // The real function writes nothing without a gate: an audit file is owed exactly when some call carried one.
  if (args[0]) globalThis.__auditOwed = true;
  const run = chain.then(() => real.recordHumanDecision(...args));
  chain = run.catch(() => {});
  (globalThis.__heldRecords ??= []).push(run);
  return run;
};
`;
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
