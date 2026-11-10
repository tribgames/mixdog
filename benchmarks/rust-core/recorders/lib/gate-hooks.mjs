// Loader hook of the channel-start recorders: puts a gate in front of the provider registry's `initProviders`, the first
// await of Node's automation start (owned-runtime/automation-start.mjs), so a recorder can hold the start there and take a
// readback or a stop at exactly that point. The product file is untouched; the gate only delays the call.
export async function load(url, context, nextLoad) {
  if (url.endsWith('/orchestrator/providers/registry.mjs')) {
    const source = `import * as real from ${JSON.stringify(`${url}?real`)};
export * from ${JSON.stringify(`${url}?real`)};
export const initProviders = async (...args) => {
  await globalThis.__mixdogGate?.providerInit?.();
  return real.initProviders(...args);
};
`;
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
