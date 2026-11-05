#!/usr/bin/env node
/**
 * scripts/build-tui.mjs — bundle the React/ink TUI (JSX) to plain ESM.
 *
 * mixdog is otherwise zero-build (plain .mjs), but the React/ink render
 * layer needs JSX transpilation. esbuild compiles src/tui/*.jsx into a single
 * ESM bundle at src/tui/dist/index.mjs.
 *
 * What is bundled vs external:
 *   - bundled: our JSX and the local modules it imports, plus Mixdog's patched
 *     Ink with its whole dependency tree (see bundleInkPlugin).
 *   - external: React and every package our own code imports.
 *
 * Run:  node scripts/build-tui.mjs   (or `npm run build:tui`)
 */
import { build } from 'esbuild';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelCatalogWorkerDefine } from './model-catalog-worker-source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'tui');

const sharedRuntimeExternalPlugin = {
  name: 'mixdog-shared-runtime-external',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/runtime\/shared\/process-(shutdown|lifecycle)\.mjs$/ }, (args) => ({
      path: `../../runtime/shared/${args.path.slice('../runtime/shared/'.length)}`,
      external: true,
    }));
  },
};

const sessionClientExternalPlugin = {
  name: 'mixdog-session-client-external',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/standalone\/protocol-session\/index\.mjs$/ }, () => ({
      // Keep this module outside the TUI bundle so its import.meta.url stays
      // anchored in src/standalone, where packages/protocol-client is resolved from.
      path: '../../standalone/protocol-session/index.mjs',
      external: true,
    }));
  },
};

// Ink's ESM build is ~500 small files (es-toolkit alone is ~430), and loading
// them one by one cost ~150 ms of every TUI start, so Ink and everything it
// imports are bundled. React stays external so Ink's reconciler and our
// components share one React instance; packages our own code imports stay
// external. Ink's optional React DevTools bridge (DEV=true) is left out: it
// would pull ws and the uninstalled react-devtools-core into the bundle.
const bundleInkPlugin = {
  name: 'mixdog-bundle-ink',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, ({ path, importer, kind }) => {
      if (kind === 'entry-point' || isAbsolute(path)) return undefined;
      if (path === 'react' || path.startsWith('react/')) return { path, external: true };
      if (path === 'ink' || /[\\/]node_modules[\\/]/.test(importer)) return undefined;
      return { path, external: true };
    });
    build.onResolve({ filter: /^\.\/devtools\.js$/ }, ({ importer }) =>
      /[\\/]node_modules[\\/]ink[\\/]/.test(importer)
        ? { path: 'ink-devtools', namespace: 'mixdog-omitted' }
        : undefined
    );
    build.onLoad({ filter: /.*/, namespace: 'mixdog-omitted' }, () => ({ contents: '' }));
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
  // The bundled model catalog has no worker file beside src/tui/dist/.
  define: await modelCatalogWorkerDefine(),
  // Local shared helpers are bundled so relative paths stay valid from
  // src/tui/dist/. Process shutdown stays external so the CLI and checked-in
  // TUI bundle use the same process-global lifecycle state.
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
  plugins: [sharedRuntimeExternalPlugin, sessionClientExternalPlugin, bundleInkPlugin],
  logLevel: 'info',
});

process.stdout.write('build:tui ok → src/tui/dist/index.mjs\n');
