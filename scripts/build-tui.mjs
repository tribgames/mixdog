#!/usr/bin/env node
/**
 * scripts/build-tui.mjs — bundle the React/ink TUI (JSX) to plain ESM.
 *
 * mixdog is otherwise zero-build (plain .mjs), but the React/ink render
 * layer needs JSX transpilation. esbuild compiles src/tui/*.jsx into a single
 * ESM bundle at src/tui/dist/index.mjs.
 *
 * What is bundled vs external:
 *   - bundled: our JSX + vendor/ink + react (+ their deps) — a self-contained UI layer.
 *   - external: the Mixdog runtime (src/runtime/**) and non-UI vendor tree.
 *     They are imported at runtime via the engine bridge, never from JSX.
 *
 * Run:  node scripts/build-tui.mjs   (or `npm run build:tui`)
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'tui');
const INK_ENTRY = join(ROOT, 'vendor', 'ink', 'build', 'index.js');

const mixdogInkAliasPlugin = {
  name: 'mixdog-ink-alias',
  setup(build) {
    build.onResolve({ filter: /^ink$/ }, () => ({
      path: INK_ENTRY,
    }));
  },
};

const emptyInkDevtoolsPlugin = {
  name: 'empty-ink-devtools',
  setup(build) {
    build.onLoad({ filter: /[\\/]vendor[\\/]ink[\\/]build[\\/]devtools\.js$/ }, () => ({
      contents: 'export {};\n',
      loader: 'js',
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
  banner: {
    js: "import { createRequire as __mixdogCreateRequire } from 'node:module';\nconst require = __mixdogCreateRequire(import.meta.url);",
  },
  jsx: 'automatic',
  // Bundle the checked-in Mixdog Ink fork directly. Published npm installs run
  // the exact UI runtime captured in dist/ without mutating node_modules.
  external: ['../runtime/*', '../../runtime/*', '../vendor/*', '../../vendor/*'],
  plugins: [mixdogInkAliasPlugin, emptyInkDevtoolsPlugin],
  logLevel: 'info',
});

process.stdout.write('build:tui ok → src/tui/dist/index.mjs\n');
