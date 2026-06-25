#!/usr/bin/env node
/**
 * scripts/build-tui.mjs — bundle the React/ink TUI (JSX) to plain ESM.
 *
 * mixdog is otherwise zero-build (plain .mjs), but the React/ink render
 * layer needs JSX transpilation. esbuild compiles src/tui/*.jsx into a single
 * ESM bundle at src/tui/dist/index.mjs.
 *
 * What is bundled vs external:
 *   - bundled: our JSX only.
 *   - external: React, Mixdog runtime, and Mixdog's checked-in Ink renderer.
 *     Ink is loaded from vendor/ink directly, never by rewriting node_modules.
 *
 * Run:  node scripts/build-tui.mjs   (or `npm run build:tui`)
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'tui');
const DIST_TO_VENDOR_INK = '../../../vendor/ink/build/index.js';

const mixdogInkAliasPlugin = {
  name: 'mixdog-ink-alias',
  setup(build) {
    build.onResolve({ filter: /^ink$/ }, () => ({
      path: DIST_TO_VENDOR_INK,
      external: true,
    }));
  },
};

await build({
  entryPoints: [join(SRC, 'index.jsx')],
  outfile: join(SRC, 'dist', 'index.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  jsx: 'automatic',
  // Keep runtime packages external like the original CLI flow. Only `ink` is
  // redirected to Mixdog's checked-in renderer instead of node_modules/ink.
  packages: 'external',
  external: ['../runtime/*', '../../runtime/*', '../vendor/*', '../../vendor/*'],
  plugins: [mixdogInkAliasPlugin],
  logLevel: 'info',
});

process.stdout.write('build:tui ok → src/tui/dist/index.mjs\n');
