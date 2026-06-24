#!/usr/bin/env node
/**
 * scripts/patch-ink.mjs — re-apply the mixdog ink fork into node_modules/ink.
 *
 * We fork ink 7 minimally to drive the hardware cursor from the input node's
 * REAL render-time position (see vendor/ink/build/*.js and PromptInput.jsx). The
 * patched files live in vendor/ink/build as the source of truth; npm install can
 * overwrite node_modules/ink, so this script copies the four forked files back.
 * It is idempotent and verifies the fork marker. Runs automatically from
 * build-tui.mjs, and can be run standalone: `node scripts/patch-ink.mjs`.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'ink', 'build');
const TARGET = join(ROOT, 'node_modules', 'ink', 'build');

// The files that carry the `mixdog fork` patches (cursor + mouse selection).
const FILES = ['output.js', 'render-node-to-output.js', 'renderer.js', 'ink.js', 'render.js'];
const MARKER = 'mixdog fork';

function main() {
  if (!existsSync(TARGET)) {
    console.error('patch-ink: node_modules/ink/build not found — run npm install first.');
    process.exit(1);
  }
  for (const f of FILES) {
    const src = join(VENDOR, f);
    const dst = join(TARGET, f);
    if (!existsSync(src)) {
      console.error(`patch-ink: missing vendored ${f} — fork source is incomplete.`);
      process.exit(1);
    }
    if (!readFileSync(src, 'utf8').includes(MARKER)) {
      console.error(`patch-ink: vendored ${f} lacks the fork marker — refusing to copy.`);
      process.exit(1);
    }
    copyFileSync(src, dst);
  }
  // Verify the target now carries the fork.
  const ok = FILES.every((f) => readFileSync(join(TARGET, f), 'utf8').includes(MARKER));
  if (!ok) {
    console.error('patch-ink: verification failed — fork marker absent after copy.');
    process.exit(1);
  }
  console.log('patch-ink ok → node_modules/ink (cursor fork applied)');
}

main();
