// The fixture uses production components with an in-memory host. It never
// connects to the daemon or the installed app's profile.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProbeFixture } from '../probe-fixture-runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
await runProbeFixture({
  probeDir: here,
  // No documentLang: this fixture's document keeps no `lang` attribute.
  artifactsDir: resolve(here, '../../artifacts/extensions-layout'),
  forwardArgs: process.argv.slice(2),
});
