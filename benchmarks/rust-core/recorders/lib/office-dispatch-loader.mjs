// A module-resolution hook of the Office dispatch recorder: the Node test files of the Office tool import `./index.mjs` (the tool's
// entry point) and `./office-test-support.mjs` (their workspace helper). Whoever imports them, except the two wrappers the recorder
// wrote, gets the wrapper instead, which records every call and then runs the real module. The product tree is only read.
let config;

export function initialize(data) {
  config = data;
}

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if ((context.parentURL ?? '').startsWith(config.wrappers)) return resolved;
  if (resolved.url === config.realIndex) return { url: config.wrapperIndex, format: 'module', shortCircuit: true };
  if (resolved.url === config.realSupport) return { url: config.wrapperSupport, format: 'module', shortCircuit: true };
  return resolved;
}
