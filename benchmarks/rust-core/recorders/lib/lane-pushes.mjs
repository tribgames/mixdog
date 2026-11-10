// Node's push lanes, driven as the relay driver drives them: the real `createRelayPushLanes` (remote-relay-push-lanes.ts) delivers desktop events
// to the clients of a registry, and the real call dispatch (remote-relay-client-calls.ts) applies a phone's `setRemoteLanes` to its state. The
// state is the registry's own (a fresh client has `lanes: null`, which reads every lane). Per registration phase, every kind of push is raised
// and the events the phone receives are recorded, with the frames the phone is given when it joins.
import { importFrom } from './common.mjs';

/** The phases a phone passes through, and the lane set it has registered at each (null: not registered yet). */
export const LANE_PHASES = [
  { phase: 'connected-before-registration', lanes: null },
  { phase: 'registered-empty', lanes: [] },
  { phase: 'lane-terminal-registered', lanes: ['terminal'] },
  { phase: 'lane-terminal-dropped', lanes: [] },
];

export async function recordNodeLanes(tree, phases) {
  const main = 'apps/desktop/src/main/';
  const { createRelayPushLanes } = await importFrom(tree, `${main}remote-relay-push-lanes.ts`);
  const { createRelayClientCallDispatch } = await importFrom(tree, `${main}remote-relay-client-calls.ts`);
  const { createRelayClientRegistry } = await importFrom(tree, `${main}remote-relay-clients.ts`);
  const { ACTIVITY_RAIL_PINS_EVENT } = await importFrom(tree, 'apps/desktop/src/shared/activity-rail-pins.ts');
  const { VISUALIZE_REMOTE_DESKTOP_EVENT } = await importFrom(tree, 'apps/desktop/src/shared/visualize.ts');

  const registry = createRelayClientRegistry({
    host: {},
    onClientCountChanged() {},
    onEmpty() {},
    sendEnvelope() {},
  });
  const state = registry.open('phone', {}, '');
  state.channel = {};
  const received = [];
  let desktopListener = () => {};
  let terminalListener = () => {};
  const push = createRelayPushLanes({
    clients: registry.clients,
    broadcastEncrypted: (payload, _droppable, include) => {
      if (!include || include(state)) received.push(payload.event);
    },
    subscribeTerminalData: (listener) => {
      terminalListener = listener;
      return () => {};
    },
    subscribeDesktopEvents: (listener) => {
      desktopListener = listener;
      return () => {};
    },
  });
  const dispatch = createRelayClientCallDispatch({
    host: {},
    methods: {},
    attached: () => true,
    acknowledgePaintProbe: () => null,
    sendEncryptedFrame: async () => {},
  });
  const events = [
    ['terminal output', () => terminalListener({ id: 't1', data: 'x' })],
    ['folder change', () => desktopListener({ name: 'folder-changed', value: { dir: '/p' } })],
    ['language diagnostics', () => desktopListener({ name: 'lsp-diagnostics', value: { uri: 'u' } })],
    ['visualize state', () => desktopListener({ name: VISUALIZE_REMOTE_DESKTOP_EVENT, value: { sessionId: 's', state: { tabs: [] } } })],
    ['activity rail pins', () => desktopListener({ name: ACTIVITY_RAIL_PINS_EVENT, value: { pins: [] } })],
  ];
  const trace = { joinFrames: push.joinFrames().map((frame) => frame.event), phases: [] };
  let id = 0;
  for (const { phase, lanes } of phases) {
    if (lanes) await dispatch('phone', state, { id: (id += 1), method: 'setRemoteLanes', params: [lanes] }, 0);
    const heard = {};
    for (const [label, raise] of events) {
      received.length = 0;
      raise();
      // The terminal buffer flushes on its own short timer after the first (leading-edge) chunk.
      await new Promise((resolve) => setTimeout(resolve, 40));
      heard[label] = [...received];
    }
    trace.phases.push({ phase, registered: lanes, heard });
  }
  push.dispose();
  return trace;
}