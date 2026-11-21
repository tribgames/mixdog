import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startCore } from '../../../scripts/rust-core/lib/core-session.mjs';

/** The env name the Electron side reads the isolated core's runtime root from (core-transport.ts COMPUTER_CORE_RUNTIME_ROOT). */
export const COMPUTER_CORE_RUNTIME_ROOT = 'MIXDOG_COMPUTER_CORE_RUNTIME_ROOT';

/**
 * Runs `work({ env, dataDir })` against a fresh core; `env` is what the Electron harness process needs to reach it (pass it to
 * `electronProcessEnv`) and `dataDir` is the data directory the core runs on (its computer-failures bundles are read from it). The core and its profile are removed afterwards, whatever `work` did.
 */
export async function withComputerCore(work, { clientName = 'computer-core-harness' } = {}) {
  const bin = process.env.MIXDOGD_TEST_BIN || process.env.MIXDOGD_BIN;
  if (!bin || !existsSync(bin)) {
    throw new Error('MIXDOGD_TEST_BIN (a mixdogd built with --features test-hooks) names no file.');
  }
  const root = mkdtempSync(join(tmpdir(), 'mixdog-computer-core-'));
  let core = null;
  try {
    core = await startCore({
      bin,
      root,
      config: { desktop: { computerControl: true, computerInstalled: true } },
      extraEnv: {
        MIXDOGD_TEST_HOOKS: '1',
        ...(process.env.MIXDOG_COMPUTER_BIN ? { MIXDOG_COMPUTER_BIN: process.env.MIXDOG_COMPUTER_BIN } : {}),
      },
      clientName,
    });
    return await work({ env: { [COMPUTER_CORE_RUNTIME_ROOT]: core.paths.runtimeRoot }, dataDir: core.paths.dataDir });
  } finally {
    // The core's own stop, else its tree ended by handle; a failed stop is reported, not thrown over the run's outcome.
    if (core) await core.stop().catch((error) => console.error(error.message));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
  }
}
