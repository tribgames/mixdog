import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProbeFixture } from '../probe-fixture-runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
await runProbeFixture({
  probeDir: here,
  artifactsDir: resolve(here, '../../artifacts/local-provider-ui'),
  documentLang: 'ko',
  // main.cjs reads the output directory only, so this probe forwards no argv.
  forwardArgs: [],
});
