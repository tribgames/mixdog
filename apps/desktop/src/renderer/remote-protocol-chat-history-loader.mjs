// The history recorder's TypeScript loader (remote-protocol-chat-history.record.mjs). tsx loads modules on a hooks thread of its own
// (module.register): an `import()` Node's code does while a case runs is then answered by that thread on real time, outside every clock,
// and the world can look quiet while one is still loading. These hooks (module.registerHooks) run on the importing thread itself and
// transform synchronously (esbuild's transformSync, the transformer tsx uses), so loading a module is part of the turn that asked for it.
//
//   node --import ./src/renderer/remote-protocol-chat-history-loader.mjs ...
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const esbuild = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'))('esbuild');
const TS = /\.(c|m)?tsx?$/;

// TypeScript's own resolution of relative specifiers: `./x.js` naming `./x.ts`, an extensionless `./x`, a folder's `index`.
const candidates = (specifier) => {
  const base = specifier.replace(/\.(c|m)?js$/, '');
  const ext = specifier.match(/\.(c|m)?js$/)?.[1] ?? '';
  return [`${base}.${ext}ts`, `${base}.${ext}tsx`, `${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`, `${specifier}/index.tsx`, `${specifier}.js`, `${specifier}.mjs`, `${specifier}/index.js`];
};

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!/^\.{1,2}\//.test(specifier) || error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      for (const candidate of candidates(specifier)) {
        try {
          return next(candidate, context);
        } catch {}
      }
      throw error;
    }
  },
  load(url, context, next) {
    // A JSON module imported without `with { type: 'json' }` (TypeScript's resolveJsonModule; tsx allows it): its default export.
    if (url.startsWith('file:') && url.endsWith('.json') && context.importAttributes?.type !== 'json') {
      return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
    }
    if (!url.startsWith('file:') || !TS.test(url)) return next(url, context);
    const file = fileURLToPath(url);
    const { code } = esbuild.transformSync(readFileSync(file, 'utf8'), {
      loader: url.endsWith('x') ? 'tsx' : 'ts',
      format: 'esm',
      target: 'node22',
      jsx: 'automatic',
      sourcefile: file,
      sourcemap: 'inline',
    });
    return { format: 'module', source: code, shortCircuit: true };
  },
});
