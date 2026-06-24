#!/usr/bin/env node
/**
 * scripts/build-tui.mjs — bundle the React/ink TUI (JSX) to plain ESM.
 *
 * mixdog-cli is otherwise zero-build (plain .mjs), but the React/ink render
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
  jsx: 'automatic',
  // Only OUR JSX needs transpiling. Keep node_modules packages (ink, react,
  // their deps incl. the optional react-devtools-core) external — Node resolves
  // them at runtime from node_modules, so the bundle stays small and we avoid
  // bundling optional/native deps. Also keep the sync-managed mixdog runtime and
  // reference vendor tree external.
  packages: 'external',
  external: ['../runtime/*', '../../runtime/*', '../vendor/*', '../../vendor/*'],
  logLevel: 'info',
});

process.stdout.write('build:tui ok → src/tui/dist/index.mjs\n');
