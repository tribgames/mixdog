// session-create/route-prep.mjs — everything a new provider session needs
// before it can be built: persisted config, the memory snapshot, a resolved
// route model + effort, and a configured provider.
import { bootProfile } from '../boot-profile.mjs';
import { runAbortable, throwIfAborted } from '../../runtime/shared/abort-race.mjs';

export const elapsedMs = (startedAt) => (performance.now() - startedAt).toFixed(1);

/** Config, memory snapshot, route model/effort and provider readiness. */
export async function prepareRoute(deps, routes, signal, startedAt) {
  const {
    rt,
    reg,
    loadCoreMemoryContext,
    awaitKeychainPrewarm,
    prepareNewSessionConfig,
    ensureConfigForRouteProvider,
  } = deps;
  const { resolveMissingRouteModelForFirstTurn, refreshRouteEffort, requireModelRoute } = routes;
  await runAbortable(signal, () => awaitKeychainPrewarm());
  // Persistence and reload precede EVERY config consumer, including memory,
  // workflow, tools and the disk-backed prompt builders. The live-session
  // return deliberately bypasses this boundary.
  await runAbortable(signal, () => prepareNewSessionConfig());
  // The memory snapshot uses the freshly adopted feature policy and still
  // overlaps the remaining provider/model preparation.
  const coreMemoryContextPromise = Promise.resolve(loadCoreMemoryContext());
  coreMemoryContextPromise.catch(() => {});
  ensureConfigForRouteProvider();
  await resolveMissingRouteModelForFirstTurn(signal);
  requireModelRoute();
  bootProfile('session:create:route-ready', { ms: elapsedMs(startedAt) });
  // Route effort waits on provider readiness while the already-started
  // memory load continues independently.
  const expectedRoute = rt.route;
  const [, coreMemoryContext] = await runAbortable(signal, () =>
    Promise.all([refreshRouteEffort(null, expectedRoute, signal), coreMemoryContextPromise])
  );
  throwIfAborted(signal);
  bootProfile('session:create:effort-ready', { ms: elapsedMs(startedAt) });
  const providerImpl = reg.getProvider(rt.route.provider);
  if (!providerImpl) {
    throw new Error(`Provider "${rt.route.provider}" is not configured.`);
  }
  bootProfile('session:create:provider-ready', { ms: elapsedMs(startedAt) });
  if (rt.closeRequested) throw new Error('runtime is closing');
  throwIfAborted(signal);
  return { coreMemoryContext, providerImpl };
}
