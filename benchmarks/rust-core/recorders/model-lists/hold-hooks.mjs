// Module hook of hold.mjs: the statusline-usage warm-up's preparation (`refreshIdleStatuslineUsage`,
// src/session-runtime/warmup/statusline-usage-warmup.mjs) first awaits the recorder's release. Every other module, and every
// other line of this one, loads as the tree has it.
const MODULE = '/src/session-runtime/warmup/statusline-usage-warmup.mjs';
const ANCHOR = 'async function refreshIdleStatuslineUsage() {';

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(MODULE)) return loaded;
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  if (source.split(ANCHOR).length !== 2) throw new Error(`hold-hooks: ${url} does not hold exactly one \`${ANCHOR}\``);
  return { ...loaded, source: source.replace(ANCHOR, `${ANCHOR} await globalThis.__mixdogRecorderHold();`), shortCircuit: true };
}
