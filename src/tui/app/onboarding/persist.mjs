// onboarding/persist.mjs
// How the wizard ends: Finish persists whatever was configured and marks
// onboarding complete; Esc/cancel on any step is a confirmed skip that marks it
// complete with routes/agents/provider untouched so it does not reopen next
// launch (`mixdog --onboarding` still reopens regardless). A daemon-backed
// store resolves both as async remote calls, so the failure path must survive
// a rejected promise too — an unhandled rejection here would surface as a
// boot-time crash instead of a notice.
export function createOnboardingPersist({ store, surface, setOnboardingActive, onboardingRef }) {
  const onboardingWarnReopen = () => {
    setOnboardingActive(false);
    void Promise.resolve()
      .then(() => store.skipOnboarding?.())
      .then(
        () => store.pushNotice('Setup skipped. Run `mixdog --onboarding` to set up later.', 'info'),
        (e) => store.pushNotice(`Couldn’t save skip: ${e?.message || e}`, 'error')
      );
  };

  /** Agents without an explicit override are left out so the session never
   *  overwrites them (they follow the Main Model dynamically at runtime). With
   *  the Main Model unset, only the explicit Web Search/agent picks are sent
   *  and the session skips agents lacking a route. Nothing configured → mark
   *  done only, config untouched. */
  const finishOnboarding = () => {
    const { defaultRoute, webSearchRoute = null, agentRoutes: overrides = {} } = onboardingRef.current;
    const hasOverrides = Object.keys(overrides || {}).length > 0;
    surface.claim().close();
    setOnboardingActive(false);
    const done = () => store.pushNotice('First-run setup complete.', 'info');
    const failed = (e) => store.pushNotice(`Couldn’t save setup: ${e?.message || e}`, 'error');
    if (defaultRoute || hasOverrides || webSearchRoute) {
      void store
        .completeOnboarding?.({
          ...(defaultRoute ? { defaultRoute } : {}),
          ...(hasOverrides ? { agentRoutes: { ...overrides } } : {}),
          ...(webSearchRoute ? { webSearchRoute } : {}),
        })
        .then(done)
        .catch(failed);
      return;
    }
    void Promise.resolve()
      .then(() => store.skipOnboarding?.())
      .then(done, failed);
  };

  return { onboardingWarnReopen, finishOnboarding };
}
