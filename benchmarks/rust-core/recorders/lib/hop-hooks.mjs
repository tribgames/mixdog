// Module loader hooks: replace chosen modules of the product tree by stand-ins that keep every
// other export of the real module (`export *`) and route the named functions to `world.api`.
// `data.stubs`: { [realFileUrl]: [exportName, ...] }, `data.world`: URL of hop-world.mjs.
let stubs = {};
let worldUrl = '';

export function initialize(data) {
  stubs = data.stubs;
  worldUrl = data.world;
}

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  const url = new URL(resolved.url);
  if (!url.search && stubs[resolved.url]) return { url: `${resolved.url}?stub`, shortCircuit: true };
  return resolved;
}

export async function load(url, context, next) {
  const at = url.indexOf('?stub');
  if (at < 0) return next(url, context);
  const real = url.slice(0, at);
  const names = stubs[real];
  const source = [
    `import { world } from ${JSON.stringify(worldUrl)};`,
    `export * from ${JSON.stringify(`${real}?real`)};`,
    ...names.map((name) => `export const ${name} = (...args) => world.api.${name}(...args);`),
  ].join('\n');
  return { format: 'module', source, shortCircuit: true };
}
