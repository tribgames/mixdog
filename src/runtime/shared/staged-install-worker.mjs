#!/usr/bin/env node
/**
 * staged-install-worker.mjs — detached background entry for staging a mixdog
 * self-update. Spawned (shell-less, hidden) by spawnStagedInstall() so the
 * npm install + relocate + verify + marker-write survive the launching session
 * quitting mid-install. Does its work and exits; the swap happens on a later
 * clean launch via performPendingSwap().
 */
import { runStagedInstall } from './staged-update.mjs';

const version = process.argv[2] || process.env.MIXDOG_STAGE_VERSION || '';
runStagedInstall(version)
  .then((r) => process.exit(r?.ok || r?.alreadyStaged || r?.inProgress ? 0 : 1))
  .catch(() => process.exit(1));
