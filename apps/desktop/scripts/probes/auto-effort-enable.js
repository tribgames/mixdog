// Turns the Auto reasoning built-in on the way the settings toggle does (the
// first enable downloads the judge model), then returns the resulting state.
(async () => {
  const startedAt = Date.now();
  const result = await window.mixdogDesktop.invokeCapability({ capability: 'setBuiltinToolEnabled', args: ['autoEffort', true] });
  return { ms: Date.now() - startedAt, autoEffort: result?.value?.autoEffort ?? null };
})()
