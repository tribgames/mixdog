// Builds an isolated renderer fixture and captures it in a hidden Electron
// window. No installed app, daemon, user profile or visible window is touched.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProbeFixture } from '../probe-fixture-runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
await runProbeFixture({
  probeDir: here,
  artifactsDir: resolve(here, '../../artifacts/ui-polish'),
  documentLang: 'ko',
  forwardArgs: process.argv.slice(2),
});
