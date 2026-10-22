import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRouteApi } from '../../tui/session/session-api/routes.mjs';
import { createSessionSettingsApi } from '../../tui/session/session-api/settings.mjs';
import { publishAgentRouteChange } from '../../session-runtime/agent-profile-changes.mjs';
import { createAgentRouteFollow } from './agent-route-follow.mjs';

const OLD = { provider: 'openai-oauth', model: 'gpt-old' };
const NEW = { provider: 'anthropic-oauth', model: 'claude-new', effort: 'high' };

/** A hosted chat: the real session route API over a runtime that records what the
 *  route write asked for (the runtime defers an established chat's pick to its next turn). */
function hostedChat({ busy = false } = {}) {
  let selected = { ...OLD };
  let state = { ...selected, busy, commandBusy: false, items: [], stats: {} };
  const calls = [];
  const runtime = {
    setRoute: async (next, options) => {
      calls.push({ next, options });
      selected = { ...selected, ...next };
      return selected;
    },
  };
  const bag = {
    runtime,
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    flushEmitImmediate() {},
    routeState: () => selected,
    syncContextStats() {},
    pushItem() {},
  };
  const api = { ...createSessionSettingsApi(bag), ...createSessionRouteApi(bag) };
  return { entry: { runtime: { setRoute: api.setRoute } }, calls, state: () => state };
}

function host(t, chats) {
  const log = [];
  const sessionsById = new Map(Object.entries(chats));
  const follow = createAgentRouteFollow({
    sessionsById,
    sessionOwner: (id) => sessionsById.get(id)?.entry ?? null,
    advance: () => ({ changed: false }),
    publishStep() {},
    log: (line) => log.push(line),
  });
  t.after(() => follow.unsubscribe());
  return log;
}

test('a bot route change reaches its idle home chat for the next turn', async (t) => {
  const home = hostedChat();
  host(t, { sess_home_writer: home });
  await publishAgentRouteChange('writer', NEW);
  assert.equal(home.calls.length, 1);
  assert.deepEqual(home.calls[0].next, { provider: NEW.provider, model: NEW.model, effort: 'high' });
  assert.equal(home.calls[0].options.sessionOnly, true);
  assert.equal(home.calls[0].options.deferUntilNextTurn, true);
  assert.equal(home.state().model, NEW.model);
});

test('a busy home chat is not refused: the pick is saved for its next turn', async (t) => {
  const home = hostedChat({ busy: true });
  host(t, { sess_home_writer: home });
  await publishAgentRouteChange('writer', NEW);
  assert.equal(home.calls.length, 1);
  assert.equal(home.calls[0].options.deferUntilNextTurn, true, 'the running turn keeps its model');
  assert.equal(home.state().model, NEW.model);
});

test('Mixy, room members of the bot and the latest change are followed; other bots are not', async (t) => {
  const mixy = hostedChat();
  const member = hostedChat();
  const other = hostedChat();
  const otherMember = hostedChat();
  const coding = hostedChat();
  host(t, {
    sess_home_lead: mixy,
    sess_rmem_room01_writer: member,
    sess_home_editor: other,
    sess_rmem_room01_editor: otherMember,
    sess_task_1: coding,
  });
  await publishAgentRouteChange('lead', NEW);
  await publishAgentRouteChange('writer', NEW);
  await publishAgentRouteChange('writer', { provider: 'openai', model: 'gpt-latest' });
  assert.equal(mixy.calls.length, 1);
  assert.deepEqual(member.calls.map((call) => call.next.model), [NEW.model, 'gpt-latest']);
  assert.equal(member.state().model, 'gpt-latest');
  for (const untouched of [other, otherMember, coding]) assert.equal(untouched.calls.length, 0);
});

test('overlapping publications reach every chat in publication order, even when one chat stalls', async (t) => {
  let release;
  const stalled = new Promise((resolve) => {
    release = resolve;
  });
  const seen = { home: [], member: [] };
  const recorder = (name, stall) => ({
    entry: {
      runtime: {
        setRoute: async (pick) => {
          if (stall && seen[name].length === 0) await stalled;
          seen[name].push(pick.model);
        },
      },
    },
  });
  host(t, { sess_home_writer: recorder('home', true), sess_rmem_room01_writer: recorder('member', false) });
  const first = publishAgentRouteChange('writer', { provider: 'openai', model: 'older' });
  const second = publishAgentRouteChange('writer', { provider: 'openai', model: 'newer' });
  // The member is not held up by the stalled home chat, and never sees them swapped.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seen.member, ['older', 'newer']);
  assert.deepEqual(seen.home, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(seen.home, ['older', 'newer']);
  assert.deepEqual(seen.member, ['older', 'newer']);
});

test('a route the chat refuses is logged and leaves the other chats alone', async (t) => {
  const refusing = { entry: { runtime: { setRoute: async () => Promise.reject(new Error('signed out')) } } };
  const member = hostedChat();
  const log = host(t, { sess_home_writer: refusing, sess_rmem_room01_writer: member });
  await publishAgentRouteChange('writer', NEW);
  assert.equal(member.calls.length, 1);
  assert.match(log[0], /sess_home_writer.*signed out/);
});
