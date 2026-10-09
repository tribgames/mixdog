import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProbeFixture } from '../probe-fixture-runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
await runProbeFixture({
  probeDir: here,
  artifactsDir: resolve(here, '../../artifacts/local-provider-layout-mockups'),
  documentLang: 'ko',
});
