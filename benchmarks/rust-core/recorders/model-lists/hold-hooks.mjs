// Module hook of hold.mjs. Two functions of the tree first await the recorder, each at the very start of its body, and
// otherwise run as the tree has them; every other module, and every other line of these, loads unchanged:
// - the statusline-usage warm-up's preparation (`refreshIdleStatuslineUsage`,
//   src/session-runtime/warmup/statusline-usage-warmup.mjs) awaits its release;
// - the provider-model load (`loadProviderModelsFresh`, src/session-runtime/provider-models/catalog-load.mjs) awaits
//   the load hold, which holds nothing unless the recorder armed it (hold.mjs).
// Each entry: the module, the anchor text (once in it), and what the anchor becomes.
const HOOKS = [
  ['/src/session-runtime/warmup/statusline-usage-warmup.mjs', 'async function refreshIdleStatuslineUsage() {', (a) => `${a} await globalThis.__mixdogRecorderHold();`],
  // The anchor is the body's first line. An unheld load awaits nothing, so it runs with no added tick.
  ['/src/session-runtime/provider-models/catalog-load.mjs', 'const startedAt = performance.now();', (a) => `{ const held = globalThis.__mixdogRecorderLoadHold(); if (held) await held; } ${a}`],
];

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  const hook = HOOKS.find(([module]) => url.endsWith(module));
  if (!hook) return loaded;
  const [, anchor, hooked] = hook;
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  if (source.split(anchor).length !== 2) throw new Error(`hold-hooks: ${url} does not hold exactly one \`${anchor}\``);
  return { ...loaded, source: source.replace(anchor, hooked(anchor)), shortCircuit: true };
}
