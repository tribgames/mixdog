#!/usr/bin/env node
/**
 * Builds the JSX bench entry and runs it in-process. Keeping this public
 * launcher as .mjs matches the other scripts/ benches while the entry can mount
 * the production JSX transcript components without relying on the TUI bundle.
 */
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Match the production CLI (src/cli.mjs defaults NODE_ENV to production):
// otherwise the bench measures react-reconciler's dev-build overhead that
// real runs no longer pay.
process.env.NODE_ENV ||= 'production';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(ROOT, 'scripts', 'tui-runtime-load-bench-entry.jsx');
const outfile = join(ROOT, 'scripts', '.tui-runtime-load-bench.tmp.mjs');

const inkAlias = {
  name: 'mixdog-ink-alias',
  setup(ctx) {
    ctx.onResolve({ filter: /^ink$/ }, () => ({
      path: '../vendor/ink/build/index.js',
      external: true,
    }));
  },
};

try {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    jsx: 'automatic',
    packages: 'external',
    plugins: [inkAlias],
    banner: {
      js: "import { createRequire as __mixdogCreateRequire } from 'node:module';\nconst require = __mixdogCreateRequire(import.meta.url);",
    },
    logLevel: 'silent',
  });
  await import(`${pathToFileURL(outfile).href}?run=${Date.now()}`);
} finally {
  await rm(outfile, { force: true });
}
