// onboarding/step-data.mjs
// Step 2's data (provider models + agent roster) on the shared wizard state:
// a background prefetch kicked as soon as Step 1 opens so advancing renders
// instantly instead of flashing an empty panel, and the on-entry loads Step 2
// falls back to when the prefetch has not landed.
const agentRosterEntry = (a) => ({ id: a.id, label: a.label || a.id, description: a.description || '' });

export function createOnboardingStepData({ store, onboardingRef, providerModelsCacheRef, onboardingPrefetchSeqRef }) {
  const hasProviderModels = () =>
    Array.isArray(onboardingRef.current.providerModels) && onboardingRef.current.providerModels.length > 0;
  const hasAgents = () => Array.isArray(onboardingRef.current.agents) && onboardingRef.current.agents.length > 0;

  /** On-entry load; a failure leaves the list empty and notices. */
  async function loadProviderModels() {
    try {
      onboardingRef.current.providerModels = await store.listProviderModels();
      providerModelsCacheRef.current = { models: onboardingRef.current.providerModels, at: Date.now() };
    } catch (e) {
      onboardingRef.current.providerModels = [];
      store.pushNotice(`could not list models: ${e?.message || e}`, 'warn');
    }
  }

  /** Remote call on a daemon-backed store: resolve it instead of mapping the
   *  promise (which silently left the roster empty). */
  async function loadAgents() {
    try {
      onboardingRef.current.agents = ((await store.listAgents?.()) || []).map(agentRosterEntry);
    } catch (e) {
      onboardingRef.current.agents = [];
      store.pushNotice(`could not list agents: ${e?.message || e}`, 'warn');
    }
  }

  function prefetchOnboardingStep2() {
    if (!hasProviderModels()) {
      const seq = onboardingPrefetchSeqRef.current;
      void Promise.resolve(store.listProviderModels?.())
        .then((models) => {
          // Drop a stale result: if the provider cache was invalidated (auth
          // change) while this load was in flight, its generation moved on.
          if (seq !== onboardingPrefetchSeqRef.current) return;
          if (Array.isArray(models) && models.length) {
            onboardingRef.current.providerModels = models;
            providerModelsCacheRef.current = { models, at: Date.now() };
          }
        })
        .catch(() => {
          /* Step 2 falls back to its own load on entry. */
        });
    }
    if (!hasAgents()) {
      void Promise.resolve(store.listAgents?.())
        .then((list) => {
          const roster = (Array.isArray(list) ? list : []).map(agentRosterEntry);
          if (roster.length) onboardingRef.current.agents = roster;
        })
        .catch(() => {
          /* Step 2 retries on entry. */
        });
    }
  }

  return { hasProviderModels, hasAgents, loadProviderModels, loadAgents, prefetchOnboardingStep2 };
}
