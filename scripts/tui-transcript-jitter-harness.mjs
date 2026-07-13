#!/usr/bin/env node
import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(ROOT, 'scripts', 'tui-transcript-jitter-harness-entry.jsx');
const outfile = join(ROOT, 'scripts', '.tui-transcript-jitter-harness.tmp.mjs');

const inkAlias = {
  name: 'mixdog-ink-alias',
  setup(ctx) {
    ctx.onResolve({ filter: /^ink$/ }, () => ({
      path: '../vendor/ink/build/index.js',
      external: true,
    }));
  },
};

// Build-only probe: records the exact delta seen by the production helper
// without adding another stateful estimator call from the harness.
const growthProbe = {
  name: 'streaming-tail-growth-probe',
  setup(ctx) {
    ctx.onLoad({ filter: /transcript-window\.mjs$/ }, async (args) => {
      let source = (await readFile(args.path, 'utf8')).replace(/\r\n/g, '\n');
      const target = '  return { tailRows: idEntry.rows, delta };';
      const replacement = `  globalThis.__mixdogTailGrowthProbe = { live, baseline, delta, tailRows: idEntry.rows };\n${target}`;
      if (!source.includes(target)) return null;
      source = source.replace(target, replacement);
      return { contents: source, loader: 'js' };
    });
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
    plugins: [inkAlias, growthProbe],
    banner: {
      js: "import { createRequire as __mixdogCreateRequire } from 'node:module';\nconst require = __mixdogCreateRequire(import.meta.url);",
    },
    logLevel: 'silent',
  });
  await import(`${pathToFileURL(outfile).href}?run=${Date.now()}`);
} finally {
  await rm(outfile, { force: true });
}


