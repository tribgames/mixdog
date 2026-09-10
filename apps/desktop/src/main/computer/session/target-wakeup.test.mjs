import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerUseCoordinator } from './coordinator.ts';

for (const withdrawal of ['cancel', 'timeout']) {
  test(`target waiters wake when a lease-free predecessor leaves by ${withdrawal}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const coordinator = new ComputerUseCoordinator({ targetLeaseGraceMs: 10000 });
    t.after(() => coordinator.reset());
    await coordinator.acquireTargets('owner', ['one']);
    const predecessor = coordinator.acquireTargets('first', ['one', 'two'], 100);
    const successor = coordinator.acquireTargets('second', ['two'], 1000);
    if (withdrawal === 'cancel') coordinator.releaseTargets('first');
    else t.mock.timers.tick(100);
    assert.equal((await predecessor).status, withdrawal === 'cancel' ? 'cancelled' : 'timeout');
    const result = await successor;
    assert.equal(result.status, 'acquired');
    assert.equal(result.queued, true, 'grant still requires fresh observation, not replay');
    assert.equal(coordinator.snapshot().targetLeases.find(lease => lease.windowId === 'one').sessionId, 'owner');
  });
}
