import assert from 'node:assert/strict';
import test from 'node:test';
import { viewSyncHost } from './test-support/view-sync-host.mjs';

const lead = (sessions) => sessions.find((session) => session.id === 'lead');

test('losing the daemon settles published Agents pool rows to unknown until the daemon reports again', async () => {
  const f = await viewSyncHost();
  try {
    const row = (sessionId, status, extra = {}) => ({
      tag: sessionId,
      sessionId,
      agent: 'worker',
      ownerSessionId: 'lead',
      status,
      stage: status,
      ...extra,
    });
    f.state.agents = [
      row('busy', 'running', { turnStartedAt: '2026-01-01T00:00:00.000Z', awaitingUser: 'approval' }),
      row('resting', 'idle'),
      row('stopped', 'cancelled'),
    ];
    const published = [];
    f.host.subscribeAgentPool((agents) => published.push(agents));
    await f.host.listSessions();
    await f.host.catalog.publishCatalogs();
    const byId = (agents, id) => agents.find((agent) => agent.sessionId === id);
    assert.equal(byId(published.at(-1), 'busy').status, 'running');

    f.loseTransport();
    const lost = published.at(-1);
    assert.equal(byId(lost, 'busy').status, 'unknown');
    assert.equal(byId(lost, 'busy').stage, 'unknown');
    assert.equal(byId(lost, 'busy').turnStartedAt, null);
    assert.equal(byId(lost, 'busy').awaitingUser, undefined);
    assert.equal(byId(lost, 'resting').status, 'idle');
    assert.equal(byId(lost, 'stopped').status, 'cancelled');

    // Only the daemon's next report brings `running` back.
    await f.host.catalog.publishCatalogs();
    assert.equal(byId(published.at(-1), 'busy').status, 'running');
  } finally {
    await f.close();
  }
});

test('losing the daemon stops the sidebar working flag at once; a reconnect restores it only from the daemon report', async () => {
  const f = await viewSyncHost();
  try {
    f.put('lead', 'answer');
    f.put('idle', 'answer');
    f.state.working.add('lead');
    const published = [];
    f.host.subscribeSessions((sessions) => published.push(sessions));

    const listed = await f.host.listSessions();
    assert.equal(lead(listed).working, true);
    assert.equal(lead(listed).leadWorking, true);

    // The connection dies while the daemon's last report still says running.
    f.loseTransport();
    assert.equal(published.length, 1, 'the loss republishes the catalog');
    assert.equal(lead(published[0]).working, undefined);
    assert.equal(lead(published[0]).leadWorking, undefined);
    assert.ok(lead(published[0]), 'the session itself stays listed');

    // Reconnected, the daemon reports the turn still running: it comes back.
    const restored = await f.host.listSessions();
    assert.equal(lead(restored).working, true);

    // Lost again, and the restarted daemon runs nothing: it stays cleared.
    f.loseTransport();
    f.state.working.clear();
    const settled = await f.host.listSessions();
    assert.equal(lead(settled).working, undefined);
    assert.equal(
      settled.some((session) => session.working),
      false
    );
  } finally {
    await f.close();
  }
});

test('the catalog carries a waiting approval for every session, and drops it with the daemon', async () => {
  const f = await viewSyncHost();
  try {
    f.put('lead', 'answer');
    f.put('idle', 'answer');
    f.state.working.add('lead');
    f.state.awaitingApproval.add('lead');
    const published = [];
    f.host.subscribeSessions((sessions) => published.push(sessions));

    // No pane reads `lead`: the catalog row alone says it waits on the user.
    const listed = await f.host.listSessions();
    assert.equal(lead(listed).awaitingApproval, true);
    assert.equal(lead(listed).working, true);
    assert.equal(listed.find((session) => session.id === 'idle').awaitingApproval, undefined);

    f.loseTransport();
    assert.equal(lead(published.at(-1)).awaitingApproval, undefined, 'no stale needs-you survives the loss');
  } finally {
    await f.close();
  }
});
