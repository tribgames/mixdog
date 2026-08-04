// Provider init de-dup, extracted from the agent-tool facade as a factory so
// the closure state (`_providerState` / `_providerInitPending`) stays private
// per agent instance. Behavior-preserving: function bodies are identical to the
// originals; only `reg` and the chain-gate timeout are injected.
//
// Provider init de-dup. Four goals that must not conflict:
//   (a) a parallel spawn fanout that all targets the SAME provider with the
//       SAME effective config performs at most ONE initProviders() pass
//       instead of N serially-awaited registry rebuilds,
//   (b) a provider CONFIG CHANGE still reaches initProviders() so the
//       registry's own signature guard can re-initialize it,
//   (c) two DIFFERENT config signatures for the same provider never init
//       concurrently — otherwise a slow init of the OLD config could land
//       after a fast init of the NEW config and revert the live registry to
//       stale config, and
//   (d) a SUPERSEDED request never resolves before the provider is actually
//       ready: even when its own (stale) init is dropped to satisfy (c), the
//       caller (a spawn about to run prepareSpawn) must still WAIT for the
//       latest init to finish, or it would proceed against an unprepared /
//       stale provider.
//
// Skip cache + in-flight collapse are keyed on `provider + signature(effective
// config)`. To satisfy (c) we SERIALIZE all inits per provider on a chain
// promise and re-check the latest-requested signature inside the chain: a
// request superseded by a newer signature drops its own init. To satisfy (d)
// such a dropped request does not resolve immediately — it awaits the
// provider's latest settled init (tracked as a rolling "ready" promise) so the
// caller only proceeds once the newest config is live.
export function createProviderInit(reg, providerChainGateMs) {
  // Per-provider state. `chain` serializes the ACTUAL initProviders() calls so
  // two different config signatures never run concurrently (goal c). `latestGen`
  // / `latestSig` track the newest requested config. `ready` is a rolling
  // deferred that resolves only when the LATEST requested init has completed —
  // a superseded caller awaits the ready deferred captured at call time, and
  // when a newer request arrives the older deferred ADOPTS the newer one, so a
  // superseded caller transitively waits for the latest init (goal d).
  const _providerState = new Map(); // provider -> state
  const _providerInitPending = new Map(); // provider -> { sigKey, promise } identical-sig collapse
  // Upper bound on how long a queued init waits for the PRIOR chain link before
  // proceeding anyway. A prior init that HANGS (never settles) must not poison
  // the chain and wedge every later request behind it. A hung init can never
  // *complete* against the registry, so it cannot land-after and clobber a
  // newer config (goal c only fears slow-but-completing inits) — so proceeding
  // once the gate expires is safe. Defaults to the spawn-prep cap; 0 disables.
  const PROVIDER_CHAIN_GATE_MS = providerChainGateMs;
  function providerRegistered(provider) {
    return typeof reg.getProvider !== 'function' || Boolean(reg.getProvider(provider));
  }
  function effectiveProviderConfig(config, provider) {
    const providers = { ...(config.providers || {}) };
    providers[provider] = { ...(providers[provider] || {}), enabled: true };
    return providers;
  }
  function providerStateFor(provider) {
    let s = _providerState.get(provider);
    if (!s) {
      s = { chain: Promise.resolve(), completedSig: null, latestSig: null, latestGen: 0, ready: null };
      _providerState.set(provider, s);
    }
    return s;
  }
  function providerInitSignature(provider, effectiveProviders) {
    let body;
    try { body = JSON.stringify(effectiveProviders); }
    catch { body = String(Date.now()); } // unserializable → force a fresh init
    return `${provider}\u0000${body}`;
  }
  function gateOnPrior(prior) {
    const settled = Promise.resolve(prior).catch(() => {});
    if (!(PROVIDER_CHAIN_GATE_MS > 0)) return settled;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, PROVIDER_CHAIN_GATE_MS);
      timer.unref?.();
      settled.then(() => { clearTimeout(timer); finish(); }, () => { clearTimeout(timer); finish(); });
    });
  }
  function ensureProvider(config, provider) {
    const effective = effectiveProviderConfig(config, provider);
    const sigKey = providerInitSignature(provider, effective);
    const registered = () => providerRegistered(provider);
    const s = providerStateFor(provider);
    // Completed-skip: this exact effective config is already live for this
    // provider. A config change flips sigKey so we fall through; a torn-down
    // provider (no longer registered) also does.
    if (s.completedSig === sigKey && registered()) return Promise.resolve();
    // Identical-sig collapse: a request with the SAME sigKey is already in
    // flight — share its caller promise.
    const pending = _providerInitPending.get(provider);
    if (pending && pending.sigKey === sigKey) return pending.promise;
    // New generation. Repoint the rolling `ready` deferred to THIS gen and make
    // the previous gen's deferred ADOPT the new one, so any superseded caller
    // awaiting an older deferred transitively waits for the newest init (d).
    const gen = ++s.latestGen;
    s.latestSig = sigKey;
    const prevReady = s.ready;
    let resolveReady;
    const readyPromise = new Promise((r) => { resolveReady = r; });
    s.ready = { gen, promise: readyPromise, resolve: resolveReady };
    if (prevReady && prevReady.gen < gen) {
      try { prevReady.resolve(readyPromise); } catch { /* already settled */ }
    }
    // Serialize the ACTUAL init behind the prior chain link (gated so a hung
    // prior cannot wedge the chain). A superseded gen's chain link settles
    // quickly — it never awaits a later gen — so there is no deadlock.
    const prior = s.chain;
    const chainLink = gateOnPrior(prior).then(async () => {
      if (s.latestGen !== gen) {
        // Superseded before we ran: drop our (stale) init entirely (goal c).
        // Our `ready` deferred already adopts the newer gen, so the caller below
        // still waits for the latest init. Settle now to release the chain.
        return;
      }
      try {
        if (!(s.completedSig === sigKey && registered())) {
          await reg.initProviders(effective);
          s.completedSig = sigKey;
        }
      } finally {
        // ALWAYS release this gen's waiters once we are the latest — even on a
        // registry init failure. Adopting (superseded) callers chained onto this
        // deferred would otherwise hang forever; instead they proceed and their
        // own createSession()/prep-timeout surfaces the unprepared provider.
        resolveReady();
      }
    });
    // Next chain link waits on us (settled, never poisoned).
    s.chain = chainLink.catch(() => {});
    // The CALLER awaits the ready deferred (resolves only when the LATEST init
    // for this provider completes), not just the chain link — so a superseded
    // caller blocks until the newest config is live (goal d). chainLink is
    // awaited first so a registry init error surfaces to this caller.
    const callerPromise = chainLink.then(() => readyPromise).finally(() => {
      const cur = _providerInitPending.get(provider);
      if (cur && cur.promise === callerPromise) _providerInitPending.delete(provider);
    });
    _providerInitPending.set(provider, { sigKey, promise: callerPromise });
    return callerPromise;
  }

  return { ensureProvider };
}
