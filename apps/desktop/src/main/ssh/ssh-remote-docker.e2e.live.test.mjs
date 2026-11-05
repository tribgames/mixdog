// LR §11.11 against a real server (a container, a VM or a Mac): the install
// that really uploads `mixdogd`, starts the core, attaches, refuses an older
// desktop and cleans up. It installs on MIXDOG_SSH_E2E_TARGET and stays out of
// every lane until that is set; run it once per server OS (Linux x64/arm64,
// macOS) with the desktop's staged runtimes (scripts/stage-core.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bootstrapRemoteDaemon } from './remote-bootstrap.ts';
import { cleanupRemoteServer } from './remote-cleanup.ts';
import { loadServerPayloads, localServerCoresDir } from './remote-install-payload.ts';
import { parseSshTarget } from './ssh-command.ts';

const TARGET = process.env.MIXDOG_SSH_E2E_TARGET;

test('real server: install, attach, refuse an older desktop, clean up', { skip: !TARGET && 'MIXDOG_SSH_E2E_TARGET is not set' }, async () => {
  const target = parseSshTarget(TARGET);
  const payloads = await loadServerPayloads(localServerCoresDir(import.meta.dirname));
  const lines = [];
  const log = (line) => lines.push(line);
  try {
    const first = await bootstrapRemoteDaemon({ target, payloads, log });
    assert.ok(first.report.healthy && first.report.coreCurrent, lines.join('\n'));
    assert.ok(first.discovery.rpcPort > 0 && first.discovery.token);

    // Equal: the second connect attaches to the same core without installing.
    const second = await bootstrapRemoteDaemon({ target, payloads, log });
    assert.equal(second.discovery.pid, first.discovery.pid);
    assert.equal(second.report.started, false);

    // Older desktop: refused by the server's own version order; nothing is replaced.
    const older = { ...payloads, identity: { version: '0.0.1', build: 'older', installId: '0.0.1-older' } };
    await assert.rejects(bootstrapRemoteDaemon({ target, payloads: older, log }), (error) => error.code === 'client-outdated');
    const after = await bootstrapRemoteDaemon({ target, payloads, log });
    assert.equal(after.discovery.pid, first.discovery.pid);
  } finally {
    await cleanupRemoteServer(TARGET, { removeUserData: true, payloads });
  }
});
