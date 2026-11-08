import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientEvent, ConnectionStatus, Json } from '../../../packages/protocol-client/src/index.ts';
import { createScreenReporter, SCREEN_SESSIONS_CHANGED, type ScreenSource } from './screen-reporter.ts';

const READY = { state: 'ready' } as unknown as ConnectionStatus;
const RECONNECTING = { state: 'reconnecting' } as unknown as ConnectionStatus;

function rig() {
  const sent: Array<{ method: string; params: Json }> = [];
  const listeners = new Set<(event: ClientEvent) => void>();
  const client = {
    status: READY,
    notify(method: string, params: Json) {
      if (client.status.state !== 'ready') throw new Error('connectionLost');
      sent.push({ method, params });
    },
    on(listener: (event: ClientEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const state = { active: true, threads: ['t1'] as string[], browserId: 'b1' as string | undefined };
  const source: ScreenSource = { active: () => state.active, threads: () => state.threads, browserId: () => state.browserId };
  const status = (next: ConnectionStatus) => {
    client.status = next;
    for (const listener of [...listeners]) listener({ type: 'status', status: next });
  };
  return { sent, client, state, source, status };
}

test('the set is sent when it changes and not repeated when it does not', () => {
  const { sent, client, state, source } = rig();
  const reporter = createScreenReporter(client, source);
  assert.deepEqual(sent, [{ method: SCREEN_SESSIONS_CHANGED, params: { sessionIds: ['t1'], browserId: 'b1', foreground: true } }]);
  reporter.refresh();
  assert.equal(sent.length, 1, 'an unchanged set is not sent again');
  state.threads = ['t1', 't2', 't2'];
  reporter.refresh();
  assert.deepEqual(sent[1]?.params, { sessionIds: ['t1', 't2'], browserId: 'b1', foreground: true });
});

test('a hidden page or a backgrounded app sends the empty set', () => {
  const { sent, client, state, source } = rig();
  const reporter = createScreenReporter(client, source);
  state.active = false;
  reporter.refresh();
  assert.deepEqual(sent.at(-1)?.params, { sessionIds: [], browserId: 'b1', foreground: false });
  state.active = true;
  reporter.refresh();
  assert.deepEqual(sent.at(-1)?.params, { sessionIds: ['t1'], browserId: 'b1', foreground: true });
});

test('every new connection sends the set again, and nothing is sent while not ready', () => {
  const { sent, client, state, source, status } = rig();
  const reporter = createScreenReporter(client, source);
  status(RECONNECTING);
  state.threads = ['t9'];
  reporter.refresh();
  assert.equal(sent.length, 1, 'no send while the connection is down');
  status(READY);
  assert.deepEqual(sent.at(-1)?.params, { sessionIds: ['t9'], browserId: 'b1', foreground: true });
  status(RECONNECTING);
  status(READY);
  assert.equal(sent.length, 3, 'the same set is sent again on the next connection');
});

test('the visualize panels on screen are reported whatever the page visibility, beside the foreground flag', () => {
  const { sent, client, state, source } = rig();
  const panels = { shown: ['t1', 't1', 't3'] };
  const reporter = createScreenReporter(client, { ...source, visualizePanels: () => panels.shown });
  assert.deepEqual(sent[0]?.params, { sessionIds: ['t1'], browserId: 'b1', visualizeSessionIds: ['t1', 't3'], foreground: true });
  state.active = false;
  reporter.refresh();
  assert.deepEqual(sent[1]?.params, { sessionIds: [], browserId: 'b1', visualizeSessionIds: ['t1', 't3'], foreground: false });
  panels.shown = [];
  reporter.refresh();
  assert.deepEqual(sent[2]?.params, { sessionIds: [], browserId: 'b1', visualizeSessionIds: [], foreground: false });
});

test('the browser id is optional and clipped to 64 units; a stopped reporter is quiet', () => {
  const { sent, client, state, source, status } = rig();
  state.browserId = undefined;
  const reporter = createScreenReporter(client, source);
  assert.deepEqual(sent[0]?.params, { sessionIds: ['t1'], foreground: true });
  state.browserId = 'x'.repeat(80);
  reporter.refresh();
  assert.deepEqual(sent[1]?.params, { sessionIds: ['t1'], browserId: 'x'.repeat(64), foreground: true });
  reporter.stop();
  status(RECONNECTING);
  status(READY);
  assert.equal(sent.length, 2);
});
