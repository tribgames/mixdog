#!/usr/bin/env node
/**
 * scripts/build-tui.mjs — bundle the React/ink TUI (JSX) to plain ESM.
 *
 * mixdog is otherwise zero-build (plain .mjs), but the React/ink render
 * layer needs JSX transpilation. esbuild compiles src/tui/*.jsx into a single
 * ESM bundle at src/tui/dist/index.mjs.
 *
 * What is bundled vs external:
 *   - bundled: our JSX + ink + react (+ their deps) — a self-contained UI layer.
 *   - external: the vendored mixdog runtime (src/runtime/**) and reference vendor tree.
 *     The runtime is a sync-managed copy; bundling it would fork the source and
 *     break `node scripts/sync-runtime.mjs --check`. They are imported at
 *     runtime via dynamic import from the engine bridge, never from JSX, so
 *     esbuild never needs to resolve them here.
 *
 * Run:  node scripts/build-tui.mjs   (or `npm run build:tui`)
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'tui');

const emptyInkDevtoolsPlugin = {
  name: 'empty-ink-devtools',
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/]ink[\\/]build[\\/]devtools\.js$/ }, () => ({
      contents: 'export {};\n',
      loader: 'js',
    }));
  },
};

// Re-apply the ink cursor fork (idempotent) before bundling, so a fresh
// npm install that overwrote node_modules/ink can't silently revert it.
await import('./patch-ink.mjs');

await build({
  entryPoints: [join(SRC, 'index.jsx')],
  outfile: join(SRC, 'dist', 'index.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  banner: {
    js: "import { createRequire as __mixdogCreateRequire } from 'node:module';\nconst require = __mixdogCreateRequire(import.meta.url);",
  },
  jsx: 'automatic',
  // Bundle Ink/React after patch-ink has applied the cursor fork. Published npm
  // installs then run the exact UI runtime captured in dist/ without relying on
  // a postinstall mutation of node_modules. Keep only Mixdog's runtime/vendor
  // tree external so sync-managed code is still loaded from source files.
  external: ['../runtime/*', '../../runtime/*', '../vendor/*', '../../vendor/*'],
  plugins: [emptyInkDevtoolsPlugin],
  logLevel: 'info',
});

process.stdout.write('build:tui ok → src/tui/dist/index.mjs\n');
