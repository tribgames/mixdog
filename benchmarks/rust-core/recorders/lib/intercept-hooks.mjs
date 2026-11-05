// Module hooks that stand in for the network layer of the provider adapters
// without touching product code: `ws` and `node:http2` resolve to wrappers that
// redirect every connection to the local recording hub (see intercept.mjs).
const WRAP = {
  ws: new URL('./intercept-ws.mjs', import.meta.url).href,
  'node:http2': new URL('./intercept-http2.mjs', import.meta.url).href,
  http2: new URL('./intercept-http2.mjs', import.meta.url).href,
};

let tree = '';
export function initialize(data) {
  tree = data.tree;
}

export async function resolve(specifier, context, next) {
  const fromWrapper = String(context.parentURL).includes('/recorders/lib/intercept-');
  if (!fromWrapper) {
    const target = WRAP[specifier];
    return target ? { url: target, shortCircuit: true } : next(specifier, context);
  }
  // Wrappers live outside the tree: resolve the real `ws` from the tree.
  if (specifier === 'ws') return { url: `${tree}/node_modules/ws/wrapper.mjs`, shortCircuit: true };
  return next(specifier, context);
}
