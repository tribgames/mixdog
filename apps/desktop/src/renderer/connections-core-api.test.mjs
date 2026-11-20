// The connections API over a stub protocol client: each method is one request, listeners hear the feed and the notifications.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createConnectionsCoreApi } from './connections-core-api.ts';

function world({ identity = { id: 'local', kind: 'local', name: 'pc' }, replies = {} } = {}) {
  const calls = [];
  const handlers = new Set();
  const opened = [];
  const client = {
    async call(method, params) {
      calls.push({ method, params });
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      if (method === 'connections/subscribe') return { id: 'sub1' };
      return reply ?? {};
    },
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const api = createConnectionsCoreApi({
    client: () => client,
    connection: () => identity,
    openExternal: async (url) => void opened.push(url),
  });
  const emit = (event) => {
    for (const h of [...handlers]) h(event);
  };
  const note = (method, params, feed) =>
    emit({ type: 'notification', notification: { method, params, ...(feed ? { feed: { id: feed } } : {}) } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { api, calls, opened, emit, note, settle };
}

test('list_mutations_return_the_list_again', async () => {
  const hosts = [{ id: 'a', name: 'n', target: 'h', lastConnectedAt: null, open: false }];
  const w = world({ replies: { 'connections/ssh/list': hosts, 'connections/ssh/forget': { ok: true } } });
  assert.deepEqual(await w.api.sshRenameHost('a', 'x'), hosts);
  // A forget answers with the list again.
  assert.deepEqual(await w.api.sshForgetHost('a'), { ok: true, hosts });
  assert.deepEqual(await w.api.sshUpdateHostSettings('a', { graceMinutes: 5 }), hosts);
  assert.deepEqual(
    w.calls.map((c) => c.method),
    [
      'connections/ssh/rename',
      'connections/ssh/list',
      'connections/ssh/forget',
      'connections/ssh/list',
      'connections/ssh/updateSettings',
      'connections/ssh/list',
    ]
  );
  assert.deepEqual(w.calls[0].params, { id: 'a', name: 'x' });
});

test('connect_dialog_calls_carry_their_arguments', async () => {
  const w = world({ replies: { 'connections/ssh/diagnosticsCopy': { text: 'report' } } });
  await w.api.sshInspectHostKey('u@h');
  await w.api.sshConnect({ attemptId: 'at', trustHostKey: true });
  await w.api.sshCancel('at');
  await w.api.sshAskpassReply('at', 'rq', null);
  await w.api.sshCleanupHost('a', { operationId: 'o', removeUserData: false, forget: true });
  assert.equal(await w.api.sshDiagnosticsCopy('a'), 'report');
  assert.deepEqual(
    w.calls.map((c) => c.params),
    [
      { target: 'u@h' },
      { attemptId: 'at', request: { attemptId: 'at', trustHostKey: true } },
      { attemptId: 'at' },
      { attemptId: 'at', requestId: 'rq', secret: null },
      { id: 'a', request: { operationId: 'o', removeUserData: false, forget: true } },
      { ref: 'a' },
    ]
  );
});

test('server_login_begin_opens_the_url_in_this_pcs_browser', async () => {
  const flow = {
    flowId: 'f',
    provider: 'p',
    state: 'pending',
    url: 'http://x',
    error: null,
    forwarded: true,
    openUrl: 'https://login/',
  };
  const w = world({ replies: { 'connections/ssh/serverLoginBegin': flow } });
  assert.deepEqual(await w.api.sshServerLoginBegin('a', 'p'), flow);
  assert.deepEqual(w.opened, ['https://login/']);
});

test('server_login_begin_ends_the_login_when_the_browser_does_not_open', async () => {
  const flow = {
    flowId: 'f',
    provider: 'p',
    state: 'pending',
    url: null,
    error: null,
    forwarded: false,
    openUrl: 'https://login/',
  };
  const calls = [];
  const api = createConnectionsCoreApi({
    client: () => ({
      call: async (method, params) => {
        calls.push({ method, params });
        return method.endsWith('Begin') ? flow : {};
      },
      on: () => () => {},
    }),
    connection: () => undefined,
    openExternal: async () => {
      throw new Error('no browser');
    },
  });
  await assert.rejects(api.sshServerLoginBegin('a', 'p'), /no browser/);
  assert.deepEqual(calls.at(-1), { method: 'connections/ssh/serverLoginCancel', params: { id: 'a', flowId: 'f' } });
});

test('a_core_error_keeps_its_code_first', async () => {
  const w = world({ replies: { 'connections/ports/forward': new Error('port-busy: Port 80 is taken.') } });
  await assert.rejects(w.api.forwardServerPort(80, null), (e) => /port-busy/.test(e.message));
});

test('link_and_ports_use_the_windows_own_connection_id', async () => {
  const w = world({ identity: { id: 's1', kind: 'ssh', name: 'srv' } });
  await w.api.getConnectionLink();
  await w.api.retryConnection();
  await w.api.retryConnectionNow();
  await w.api.requestConnectionSignIn();
  await w.api.forwardServerPort(3000);
  await w.api.stopServerPortForward(3000);
  await w.api.dismissServerPort(8080);
  assert.deepEqual(
    w.calls.map((c) => c.params),
    [
      { connectionId: 's1' },
      { connectionId: 's1' },
      { connectionId: 's1' },
      { connectionId: 's1' },
      { connectionId: 's1', remotePort: 3000, localPort: null },
      { connectionId: 's1', remotePort: 3000 },
      { connectionId: 's1', port: 8080 },
    ]
  );
});

test('open_port_in_browser_uses_the_active_forward', async () => {
  const w = world({
    replies: {
      'connections/ports/list': { forwards: [{ remotePort: 3000, localPort: 41000, status: 'active' }], suggested: [] },
    },
  });
  await w.api.openServerPortInBrowser(3000);
  assert.deepEqual(w.opened, ['http://127.0.0.1:41000/']);
  await assert.rejects(w.api.openServerPortInBrowser(9), /port-not-active/);
});

test('restore_setting_reads_back_what_is_stored', async () => {
  const w = world({ replies: { 'connections/restore/get': { enabled: true } } });
  assert.equal(await w.api.setReopenServerWindows(true), true);
  assert.deepEqual(
    w.calls.map((c) => c.method),
    ['connections/restore/set', 'connections/restore/get']
  );
});

test('feed_sections_reach_their_listeners_and_the_feed_is_released', async () => {
  const w = world({ identity: { id: 's1', kind: 'ssh', name: 'srv' } });
  const links = [];
  const ports = [];
  const stopLink = w.api.subscribeConnectionLink((v) => links.push(v));
  const stopPorts = w.api.subscribeServerPorts((v) => ports.push(v));
  await w.settle();
  assert.deepEqual(
    w.calls.filter((c) => c.method === 'connections/subscribe'),
    [{ method: 'connections/subscribe', params: { connectionId: 's1' } }]
  );
  w.note(
    'connections/updated',
    { section: 'connections', key: 'link/s1', revision: 1, value: { state: 1 } },
    'connections'
  );
  w.note(
    'connections/updated',
    { section: 'connections', key: 'link/other', revision: 1, value: { state: 2 } },
    'connections'
  );
  w.note(
    'feed/snapshot',
    {
      feedId: 'connections',
      state: { sections: [{ section: 'connections', key: 'ports/s1', revision: 2, value: { p: 1 } }] },
    },
    'connections'
  );
  assert.deepEqual(links, [{ state: 1 }]);
  assert.deepEqual(ports, [{ p: 1 }]);
  stopLink();
  await w.settle();
  assert.equal(
    w.calls.some((c) => c.method === 'connections/unsubscribe'),
    false
  );
  stopPorts();
  await w.settle();
  assert.deepEqual(w.calls.slice(-2), [
    { method: 'connections/unsubscribe', params: { subscriptionId: 'sub1' } },
    { method: 'feed/unsubscribe', params: { feedId: 'connections' } },
  ]);
});

test('restore_progress_is_delivered_one_entry_at_a_time_and_hosts_changes_say_so', async () => {
  const w = world();
  const seen = [];
  let changed = 0;
  w.api.subscribeServerRestoreProgress((p) => seen.push(p));
  w.api.subscribeSshHostsChanged(() => changed++);
  await w.settle();
  assert.deepEqual(w.calls[0], { method: 'connections/subscribe', params: {} });
  w.note(
    'connections/updated',
    {
      section: 'connections',
      key: 'restore',
      revision: 1,
      value: { enabled: true, progress: [{ id: 'a' }, { id: 'b' }] },
    },
    'connections'
  );
  w.note('connections/updated', { section: 'connections', key: 'hosts', revision: 1, value: [] }, 'connections');
  assert.deepEqual(seen, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(changed, 1);
  // A reopening that left the list is ready: the banner drops it.
  w.note(
    'connections/updated',
    {
      section: 'connections',
      key: 'restore',
      revision: 2,
      value: { enabled: true, progress: [{ id: 'b', name: 'B' }] },
    },
    'connections'
  );
  assert.deepEqual(seen.slice(2), [
    { id: 'a', name: '', phase: 'ready' },
    { id: 'b', name: 'B' },
  ]);
});

test('connection_scoped_notifications_reach_their_subscribers', () => {
  const w = world({ identity: { id: 's1', kind: 'ssh', name: 'srv' } });
  const got = { askpass: [], progress: [], cleanup: [], login: [], notice: [], signIn: [] };
  w.api.subscribeSshAskpass((v) => got.askpass.push(v));
  w.api.subscribeSshProgress((v) => got.progress.push(v));
  w.api.subscribeSshCleanupProgress((v) => got.cleanup.push(v));
  w.api.subscribeSshServerLoginUpdated((v) => got.login.push(v));
  w.api.subscribeConnectionNotice((v) => got.notice.push(v));
  w.api.subscribeConnectionSignIn((v) => got.signIn.push(v));
  w.note('connections/ssh/askpass', { attemptId: 'a' });
  w.note('connections/ssh/progress', { attemptId: 'a', phase: 'check' });
  w.note('connections/ssh/cleanupProgress', { id: 'a', operationId: 'o', phase: 'stop' });
  w.note('connections/ssh/serverLoginUpdated', { id: 'a', flow: { flowId: 'f' } });
  w.note('connections/notice', { connectionId: 's1', notice: { kind: 'model-sign-in', provider: 'p' } });
  w.note('connections/notice', { connectionId: 'other', notice: { kind: 'model-sign-in', provider: 'q' } });
  w.note('connections/signIn', { id: 'x', name: 'n', target: 't' });
  assert.deepEqual(got, {
    askpass: [{ attemptId: 'a' }],
    progress: [{ attemptId: 'a', phase: 'check' }],
    cleanup: [{ operationId: 'o', phase: 'stop' }],
    login: [{ id: 'a', flow: { flowId: 'f' } }],
    notice: [{ kind: 'model-sign-in', provider: 'p' }],
    signIn: [{ id: 'x', name: 'n', target: 't' }],
  });
});

test('a_new_core_connection_asks_for_the_feed_again', async () => {
  const w = world();
  w.api.subscribeSshHostsChanged(() => undefined);
  await w.settle();
  w.emit({ type: 'status', status: { state: 'reconnecting' } });
  w.emit({ type: 'status', status: { state: 'ready' } });
  await w.settle();
  assert.equal(w.calls.filter((c) => c.method === 'connections/subscribe').length, 2);
});

test('without_a_core_client_a_call_rejects_and_a_subscription_is_inert', async () => {
  const api = createConnectionsCoreApi({
    client: () => null,
    connection: () => undefined,
    openExternal: async () => {},
  });
  await assert.rejects(api.sshListHosts(), /no connection to the core/);
  assert.equal(typeof api.subscribeSshProgress(() => {}), 'function');
});

test('a_server_window_hears_the_saved_servers_change_through_its_own_subscription', async () => {
  const w = world({ identity: { id: 's1', kind: 'ssh', name: 'srv' } });
  let changed = 0;
  w.api.subscribeSshHostsChanged(() => changed++);
  await w.settle();
  // The core's feed for this connection carries the host list beside the connection's own keys.
  assert.deepEqual(w.calls[0], { method: 'connections/subscribe', params: { connectionId: 's1' } });
  w.note(
    'feed/snapshot',
    {
      feedId: 'connections',
      state: {
        sections: [
          { section: 'connections', key: 'hosts', revision: 1, value: [] },
          { section: 'connections', key: 'link/s1', revision: 1, value: {} },
        ],
      },
    },
    'connections'
  );
  w.note(
    'connections/updated',
    { section: 'connections', key: 'hosts', revision: 2, value: [{ id: 's1' }] },
    'connections'
  );
  assert.equal(changed, 2);
});

test('before_the_first_open_calls_and_listeners_wait_for_it', async () => {
  const calls = [];
  const handlers = new Set();
  const client = {
    async call(method, params) {
      calls.push({ method, params });
      return method === 'connections/subscribe' ? { id: 'sub1' } : [];
    },
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  let open = null;
  let release;
  let opening = new Promise((resolve) => (release = resolve)).then(() => (opening = null));
  const api = createConnectionsCoreApi({
    client: () => open,
    opening: () => opening,
    connection: () => ({ id: 'local', kind: 'local', name: 'pc' }),
    openExternal: async () => undefined,
  });
  const listed = api.sshListHosts();
  const heard = [];
  api.subscribeSshProgress((p) => heard.push(p));
  api.subscribeSshHostsChanged(() => heard.push('hosts'));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [], 'nothing is sent, and nothing refused, before the open');
  open = client;
  release();
  assert.deepEqual(await listed, []);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    calls.map((c) => c.method),
    ['connections/ssh/list', 'connections/subscribe']
  );
  for (const h of [...handlers]) {
    h({ type: 'notification', notification: { method: 'connections/ssh/progress', params: { step: 1 } } });
  }
  assert.deepEqual(heard, [{ step: 1 }], 'a listener added before the open hears the client once it is open');
});

test('with_no_open_in_flight_a_call_without_a_client_is_refused_at_once', async () => {
  const api = createConnectionsCoreApi({
    client: () => null,
    opening: () => null,
    connection: () => undefined,
    openExternal: async () => undefined,
  });
  await assert.rejects(() => api.sshListHosts(), /This window has no connection to the core\./);
});

// A client as the library shows it to the api: listeners it holds, a status, and a call that can be held open.
const makeClient = (id, { hold = false } = {}) => {
  const handlers = new Set();
  const held = [];
  return {
    id,
    handlers,
    held,
    status: { state: 'ready' },
    async call(method) {
      if (method !== 'connections/subscribe') return {};
      if (hold) return new Promise((resolve) => held.push(() => resolve({ id: `sub-${id}` })));
      return { id: `sub-${id}` };
    },
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
};
const rig = (first) => {
  let current = first;
  let changed = () => undefined;
  const api = createConnectionsCoreApi({
    client: () => current,
    onClientChange: (listener) => {
      changed = listener;
      return () => undefined;
    },
    connection: () => undefined,
    openExternal: async () => undefined,
  });
  return { api, set: (c) => (current = c), changed: () => changed() };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a_closed_client_is_let_go_and_a_listener_from_before_hears_the_next_one', async () => {
  const first = makeClient('a');
  const second = makeClient('b');
  const r = rig(first);
  const heard = [];
  r.api.subscribeSshAskpass((p) => heard.push(p));
  assert.equal(first.handlers.size, 1);
  first.status.state = 'closed'; // the reopen closed it; the registry still answers with it
  r.changed();
  assert.equal(first.handlers.size, 0, 'a closed client keeps no listener of the api');
  r.set(second);
  r.changed();
  [...second.handlers][0]({ type: 'notification', notification: { method: 'connections/ssh/askpass', params: 1 } });
  assert.deepEqual(heard, [1]);
});

test('a_subscription_made_in_the_gap_is_kept_and_its_unsubscribe_works', async () => {
  const closed = makeClient('a');
  closed.status.state = 'closed'; // what the registry answers with until the replacement is accepted
  const second = makeClient('b');
  const r = rig(closed);
  const heard = [];
  const off = r.api.subscribeSshAskpass((p) => heard.push(p));
  const never = r.api.subscribeSshProgress(() => assert.fail('unsubscribed'));
  never();
  assert.equal(closed.handlers.size, 0, 'a reopen that fails leaves nothing on the closed client');
  r.set(second);
  r.changed();
  assert.equal(second.handlers.size, 1);
  const emit = (method) => [...second.handlers][0]({ type: 'notification', notification: { method, params: 1 } });
  emit('connections/ssh/askpass');
  emit('connections/ssh/progress');
  assert.deepEqual(heard, [1]);
  off();
  emit('connections/ssh/askpass');
  assert.deepEqual(heard, [1]);
});

test('a_listener_added_before_the_replacement_is_accepted_does_not_cost_the_feed', async () => {
  const first = makeClient('a');
  const second = makeClient('b');
  const calls = [];
  const orig = second.call;
  second.call = (method, params) => {
    calls.push(method);
    return orig(method, params);
  };
  const r = rig(first);
  r.api.subscribeSshHostsChanged(() => undefined);
  await tick();
  first.status.state = 'closed';
  r.changed();
  r.set(second); // the registry names the replacement before the connection accepts it
  r.api.subscribeSshAskpass(() => undefined);
  r.changed();
  await tick();
  assert.deepEqual(calls, ['connections/subscribe'], 'the replacement is asked for the feed, once');
});

test('a_feed_id_answered_by_the_old_client_after_the_switch_is_not_the_new_clients', async () => {
  const first = makeClient('a', { hold: true });
  const second = makeClient('b');
  const calls = [];
  const orig = second.call;
  second.call = (method, params) => {
    calls.push(method);
    return orig(method, params);
  };
  const r = rig(first);
  const off = r.api.subscribeSshHostsChanged(() => undefined);
  await tick();
  assert.equal(first.held.length, 1, 'the old client has a subscribe outstanding');
  first.status.state = 'closed';
  r.set(second);
  r.changed();
  first.held[0](); // the old answer lands after the switch
  await tick();
  await tick();
  assert.deepEqual(calls, ['connections/subscribe'], 'the replacement subscribes for itself');
  off();
  await tick();
  assert.ok(calls.includes('connections/unsubscribe'));
});
