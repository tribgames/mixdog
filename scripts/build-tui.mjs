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
 *   - external: React and Mixdog's checked-in Ink renderer.
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
  // Keep package imports external like the original CLI flow. Local shared
  // helpers are bundled so relative paths stay valid from src/tui/dist/.
  // Only `ink` is redirected to Mixdog's checked-in renderer instead of
  // node_modules/ink.
  packages: 'external',
  // Bundled CJS helpers (e.g. src/lib/mixdog-debug.cjs) compile to esbuild's
  // __require shim, which throws "Dynamic require of ..." in plain ESM.
  // Provide a real module-scope require so those requires resolve at runtime.
  banner: {
    js: "import { createRequire as __mixdogCreateRequire } from 'node:module';\nconst require = __mixdogCreateRequire(import.meta.url);",
  },
  external: [
    '../vendor/*',
    '../../vendor/*',
    // Voice runtime modules stay external (lazy dynamic imports by design):
    // voice-runtime-fetcher.mjs resolves its bundled manifest via
    // import.meta.url ('../data/voice-runtime-manifest.json'), which breaks
    // when inlined into src/tui/dist/index.mjs (resolves to src/tui/data/).
    // The '../../runtime/...' specifier is depth-safe: src/tui/lib/* and
    // src/tui/dist/* are both 2 levels below src/, so the relative path
    // resolves to src/runtime/channels/lib/* either way.
    '../../runtime/channels/lib/voice-runtime-fetcher.mjs',
    '../../runtime/channels/lib/whisper-server.mjs',
  ],
  plugins: [mixdogInkAliasPlugin],
  logLevel: 'info',
});

process.stdout.write('build:tui ok → src/tui/dist/index.mjs\n');
