// Node resolve hook for the desktop main-process sources: they import siblings
// without extensions (tsc/bundler style). Falls back to `.ts` / `/index.ts`.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\.\.?\//.test(specifier)) throw error;
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      try {
        return await next(specifier + suffix, context);
      } catch {
        /* try the next suffix */
      }
    }
    throw error;
  }
}

// The renderer-shared sources import `.json` without the `with { type: 'json' }`
// attribute (bundler style); serve those as default-export modules.
export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.json') && !context.importAttributes?.type) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const text = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', source: `export default ${text};`, shortCircuit: true };
  }
  return next(url, context);
}
