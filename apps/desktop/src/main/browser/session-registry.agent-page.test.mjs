import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSessionRegistry } from './session-registry.ts';

const guest = (id) => ({
  id,
  destroyed: false,
  isDestroyed() {
    return this.destroyed;
  },
});
const background = (page, kind = 'popup') => ({ window: {}, guest: page, kind, lastUsedAt: 0 });

function ownedBy(sessionId, ...pages) {
  const registry = new BrowserSessionRegistry();
  for (const page of pages) {
    registry.registerVisibleGuest(page);
    registry.bindVisibleGuest(sessionId, page.id, true);
  }
  return registry;
}

test('the agent page is per session, independent of the selected page, and ends with its page', () => {
  const blank = guest(1);
  const other = guest(3);
  const popup = guest(2);
  const registry = ownedBy('a', blank);
  registry.registerVisibleGuest(other);
  registry.bindVisibleGuest('b', 3, true);
  registry.setBackgroundPage('a', 'popup-1', background(popup));

  registry.setAgentPage('a', blank, 1);
  registry.setAgentPage('a', popup, 2);
  assert.deepEqual(registry.agentPage('a'), { guest: popup, turn: 2, paused: false });
  assert.equal(registry.currentGuest('a'), blank);
  assert.equal(registry.agentPage('b'), null);

  popup.destroyed = true;
  assert.equal(registry.agentPage('a'), null);
});

test("a page another session owns is not that session's agent page", () => {
  const page = guest(1);
  const registry = ownedBy('a', page);
  registry.setAgentPage('b', page, 1);
  assert.equal(registry.agentPage('b'), null);
});

test('pausing lasts for the turn it was made in and resume lifts it', () => {
  const page = guest(1);
  const registry = ownedBy('a', page);
  registry.pauseAgentFollow('a');
  registry.setAgentPage('a', page, 1);
  assert.equal(registry.agentPage('a').paused, false, 'nothing to pause before the agent drove a page');
  registry.pauseAgentFollow('a');
  assert.equal(registry.agentPage('a').paused, true);
  registry.setAgentPage('a', page, 1);
  assert.equal(registry.agentPage('a').paused, true, 'same turn stays paused');
  registry.setAgentPage('a', page, 2);
  assert.equal(registry.agentPage('a').paused, false, 'a new turn follows again');
  registry.pauseAgentFollow('a');
  registry.resumeAgentFollow('a');
  assert.equal(registry.agentPage('a').paused, false);
});

// Each case re-attaches the same live page to its session afterwards: a
// lazy ownership check alone would bring the stale agent page back.
test('the agent page is dropped when its page leaves the session, not on the next read', () => {
  const visible = guest(1);
  const registry = ownedBy('a', visible);
  registry.setAgentPage('a', visible, 1);
  registry.unregisterVisibleGuest(visible);
  registry.registerVisibleGuest(visible);
  registry.bindVisibleGuest('a', 1, true);
  assert.equal(registry.agentPage('a'), null, 'visible page unregistered');

  const popup = guest(2);
  const entry = background(popup);
  registry.setBackgroundPage('a', 'popup-1', entry);
  registry.setAgentPage('a', popup, 2);
  registry.deleteBackgroundPage('a', 'popup-1', entry);
  registry.setBackgroundPage('a', 'popup-1', entry);
  assert.equal(registry.agentPage('a'), null, 'background page deleted');

  registry.setAgentPage('a', popup, 3);
  registry.clearBackgroundPages();
  registry.setBackgroundPage('a', 'popup-1', entry);
  assert.equal(registry.agentPage('a'), null, 'background pages cleared');

  registry.setAgentPage('a', visible, 4);
  registry.bindVisibleGuest('b', 1, true);
  registry.bindVisibleGuest('a', 1, true);
  assert.equal(registry.agentPage('a'), null, 'page moved to another session');
});

test('releasing a session forgets its agent page and pause', () => {
  const page = guest(1);
  const registry = ownedBy('a', page);
  registry.setAgentPage('a', page, 1);
  registry.pauseAgentFollow('a');
  registry.clearAgentPage('a');
  assert.equal(registry.agentPage('a'), null);
  registry.setAgentPage('a', page, 1);
  assert.deepEqual(registry.agentPage('a'), { guest: page, turn: 1, paused: false });
});
