// Starts the core the Computer Use harnesses run against: a real mixdogd on an isolated profile (a temp data dir under a temp
// root, Computer Use on), started with the test hooks (MIXDOGD_TEST_HOOKS=1, which serves `dev/computer/run`) and stopped
// when the work ends. The Electron harness entry is started by the caller inside `withComputerCore`, with the env this hands it.
//
// The binary is a test-hooks build: MIXDOGD_TEST_BIN (else MIXDOGD_BIN, as scripts/dev-core-install.mjs lays out). The hook env is
// set only on the core this module starts; a packaged core never gets it. The helper the core runs is found the way the core
// finds it; MIXDOG_COMPUTER_BIN of this environment is handed on when set (the isolated profile drops every other MIXDOG_*).
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startCore } from '../../../scripts/rust-core/lib/core-session.mjs';

/** The env name the Electron side reads the isolated core's runtime root from (core-transport.ts COMPUTER_CORE_RUNTIME_ROOT). */
export const COMPUTER_CORE_RUNTIME_ROOT = 'MIXDOG_COMPUTER_CORE_RUNTIME_ROOT';

/**
 * Runs `work({ env })` against a fresh core; `env` is what the Electron harness process needs to reach it (pass it to
 * `electronProcessEnv`). The core and its profile are removed afterwards, whatever `work` did.
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
    return await work({ env: { [COMPUTER_CORE_RUNTIME_ROOT]: core.paths.runtimeRoot } });
  } finally {
    // The core's own stop, else its tree ended by handle; a failed stop is reported, not thrown over the run's outcome.
    if (core) await core.stop().catch((error) => console.error(error.message));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
  }
}
