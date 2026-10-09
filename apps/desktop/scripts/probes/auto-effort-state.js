// The Auto reasoning built-in as the settings panel receives it: installed,
// enabled, judge ready, and the model info (release, steps support).
(async () => {
  const result = await window.mixdogDesktop.invokeCapability({ capability: 'getToolModuleSettings', args: [] });
  return result?.value?.autoEffort ?? null;
})()
