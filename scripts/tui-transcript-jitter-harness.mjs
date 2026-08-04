#!/usr/bin/env node
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(ROOT, 'scripts', 'tui-transcript-jitter-harness-entry.jsx');
const outfile = join(ROOT, 'scripts', '.tui-transcript-jitter-harness.tmp.mjs');

const inkAlias = {
  name: 'mixdog-ink-alias',
  setup(ctx) {
    ctx.onResolve({ filter: /^ink$/ }, () => ({
      path: '../node_modules/ink/build/index.js',
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


