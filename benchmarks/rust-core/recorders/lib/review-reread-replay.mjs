// What the windows of THIS checkout do when the core's `review/diff/updated` frames reach them: the replay half of
// `record-turn-review-signal.mjs`. The same `ReviewWindows` mount the checkout's `TurnReviewBar`; its bridge here is the
// renderer's section store (`createSectionStore`, reached through `sectionStoreFor(window.mixdogDesktop)` by the bar's own
// subscription) fed with `{kind: 'sections'}` pushes. A frame becomes a push the way the main process turns a scoped feed's
// section notification into one (`scopedSectionChanges`), one push per frame; each window holds the feed of its own thread only.
//
//   node --import <test-env> --import <test-tsx> review-reread-replay.mjs <checkout> <input.json>
//
// The input comes from the Rust test: per operation, the deliveries the core made (each the frames it published, parsed) and
// after how many answered requests each was made. The requests the bars send are answered with the answers Node's recording
// holds for the same request; one the recording lacks fails the replay by name. The output is the trace per operation.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReviewWindows, loadWindowKit } from './review-windows.mjs';

const [tree, inputPath] = process.argv.slice(2);
if (!tree || !inputPath) throw new Error('usage: review-reread-replay.mjs <checkout> <input.json>');
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const kit = await loadWindowKit(tree);
const { scopedSectionChanges } = await import(pathToFileURL(join(tree, 'apps/desktop/src/main/protocol/scoped-sections.ts')).href);

const canonical = (value) => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));

let unanswered = [];
const windows = new ReviewWindows(kit, async ({ session, request }) => {
  const at = unanswered.findIndex((recorded) => recorded.client === session && canonical(recorded.request) === canonical(request));
  if (at < 0) throw new Error(`the window of ${session} asked ${canonical(request)}, which the recording never saw at this point`);
  return unanswered.splice(at, 1)[0].answer;
});

/** Per session: the listeners of its window's section source and the feed route its frames are folded against. */
const clients = new Map();
const open = async ({ session, checkpoint }) => {
  const listeners = new Set();
  const api = {
    invokeCapability: (request) => windows.invoke(request),
    sections: {
      snapshot: async () => ({ status: 'ready', entries: [] }),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  clients.set(session, { listeners, route: { windows: new Set(), held: new Map() } });
  await windows.open({ session, checkpoint, api });
};

const deliver = async (frames) => {
  windows.deliveries += 1;
  for (const frame of frames) {
    const client = clients.get(frame.params.key);
    if (!client) throw new Error(`a frame for the thread ${frame.params.key}, which no window shows`);
    const changes = scopedSectionChanges(client.route, frame.method, frame.params);
    await kit.act(async () => {
      for (const listener of [...client.listeners]) listener({ kind: 'sections', changes });
    });
  }
};

const traces = [];
for (const [index, op] of input.ops.entries()) {
  const rust = input.rust[index];
  unanswered = [...input.recorded[index].requests];
  windows.startOperation();
  if (op.op === 'client') await open(op);
  let delivered = 0;
  const deliverUpTo = async (count) => {
    while (delivered < count) await deliver(rust.deliveries[delivered++]);
  };
  await deliverUpTo(rust.before);
  await windows.settle(async (answered) => deliverUpTo(rust.afterAnswer[answered - 1] ?? delivered));
  // Deliveries the windows' answers did not wait for (a window that asked less than the recording): they still reach the windows.
  await deliverUpTo(rust.deliveries.length);
  await windows.settle();
  traces.push({ op: index, ...windows.trace() });
}
await windows.close();
process.stdout.write(JSON.stringify(traces));
