import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Matches the import specifier of Monaco's built-in TypeScript/JavaScript
 *  language-service contribution (absolute or relative). A regex alias replaces only the matched part, so it matches the whole id. */
export const MONACO_TYPESCRIPT_CONTRIBUTION = /^.*[\\/]language[\\/]typescript[\\/]monaco\.contribution\.js$/;

export const MONACO_TYPESCRIPT_STUB = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/renderer/monaco-typescript-external.ts'
);

/** Vite's `resolve.alias` is not applied while the dev server pre-bundles `monaco-editor` with esbuild; this plugin
 *  applies the same replacement inside the optimizer. Production builds use the alias in electron.vite.config.ts.
 *  @returns {import('esbuild').Plugin} */
export function monacoTypescriptExternalEsbuildPlugin() {
  return {
    name: 'mixdog-monaco-typescript-external',
    setup(build) {
      build.onResolve({ filter: MONACO_TYPESCRIPT_CONTRIBUTION }, () => ({ path: MONACO_TYPESCRIPT_STUB }));
    },
  };
}
