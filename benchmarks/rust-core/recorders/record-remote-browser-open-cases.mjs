#!/usr/bin/env node
// Recording of the case "an explicit reveal or hide request is forwarded to every client as a non-droppable open event" of
// apps/desktop/src/main/remote-browser-streams.test.mjs (b6f10295a): the desktop's browser-open request (an agent's explicit open or
// hide of a session's browser surface) reaches the relay's push lanes, which broadcast it to every client as an open event whose
// second argument (droppable) is false. The real createRelayPushLanes with a scripted desktop event source and broadcast function;
// the requests and every broadcast are recorded whole.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-remote-browser-open-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';

REPLAY_TARGETS['remote-browser-open-cases'] = {
  notPublic: ['host/browser/surface -> ui/openRequested { kind: "browser" }: mixdog-app-server-daemon/src/domain_seams/browser_surfaces.rs FeedSurfaces::requested (BrowserSurfaces); `mod domain_seams` is crate-private, so the replay is a unit test of the same file'],
};
const set = openSet('remote-browser-open-cases', import.meta.url);
const { BROWSER_OPEN_REQUESTED_DESKTOP_EVENT, REMOTE_BROWSER_OPEN_EVENT } = await set.load('apps/desktop/src/shared/remote-browser.ts');
const { createRelayPushLanes } = await set.load('apps/desktop/src/main/remote-relay-push-lanes.ts');

await set.run('an explicit reveal or hide request is forwarded to every client as a non-droppable open event', async () => {
  const broadcasts = [];
  let listener;
  const push = createRelayPushLanes({
    clients: new Map([['web', { lanes: new Set() }]]),
    subscribeDesktopEvents: (next) => {
      listener = next;
      return () => {};
    },
    broadcastEncrypted: (...args) => broadcasts.push(args),
  });
  try {
    const requests = [{ sessionId: 's', reveal: true }, { sessionId: 's', hide: true }];
    for (const value of requests) listener({ name: BROWSER_OPEN_REQUESTED_DESKTOP_EVENT, value });
    return { eventName: REMOTE_BROWSER_OPEN_EVENT, requests, broadcasts };
  } finally {
    push.dispose();
  }
});

await set.finish({
  entry: { runs: 'createRelayPushLanes (remote-relay-push-lanes.ts) with a scripted desktop event source and a scripted broadcastEncrypted', notRun: 'no relay connection and no encryption: the broadcast function records its arguments', hops: 'The broadcast arguments (frame, droppable) are recorded whole.' },
  exclusions: { 'observed.broadcasts[].1': 'the second broadcast argument (droppable = false) is the Node relay\'s queue policy; the core\'s feed frame is sequenced and a client that misses one resyncs from the feed, so there is no flag to compare' },
  replay: { entry: 'a reveal or hide of a session\'s browser surface reported by the host (host/browser/surface) is published to the attached clients as ui/openRequested { kind: "browser" } with the request\'s fields; compare each published payload with the recorded broadcast payload (the core adds `kind`, declared)', normalised: {} },
});
process.exit(0);
