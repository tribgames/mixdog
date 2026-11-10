#!/usr/bin/env node
// Node's choice of what a phone's screen session streams and injects through, as a pure table
// (apps/desktop/src/main/remote-screen/secure-desktop-switch.ts and the helper cadence of screen-webrtc-source.ts):
//   decisions.json  `decideScreenSource` over the whole cartesian product of its inputs: the local watcher (none, or
//                   an input desktop named in several cases / unreadable, with or without a consent prompt and
//                   LogonUI), whether the helper is installed and connected, the desktop it reports, its WTS lock
//                   state, a stopped service and a hold by another session. Each case is a palette index; the palette
//                   is Node's output objects, whole.
//   statuses.json   `screenStatusFor` over every distinct decision × control granted × helper video × two helper-fact
//                   blocks.
//   misc.json       `screenHelperIssue`, `helperIssueAfterChange`, `decisionUsesHelper`, `secureDesktopIdentity`,
//                   `installOfferFor`, and `helperVideoStallMs` with the helper's frame interval.
// Rust's switch must give every recorded output whole for the same input.
//
//   (cd <tree>/apps/desktop && node --import tsx <repo>/benchmarks/rust-core/recorders/record-screen-control-switch.mjs --tree <tree>)
import { importTs, openTree, record } from './record-screen-control-lib.mjs';

const { tree, identity, only } = openTree();
const sw = await importTs(tree, 'apps/desktop/src/main/remote-screen/secure-desktop-switch.ts');
const cadence = await importTs(tree, 'apps/desktop/src/main/remote-screen/screen-webrtc-source.ts');
const install = await importTs(tree, 'apps/desktop/src/main/secure-desktop/install-request.ts');

const local = [null];
for (const inputDesktop of [null, 'Default', 'Winlogon', 'WINLOGON']) {
  for (const consent of [false, true]) for (const logonUi of [false, true]) local.push({ inputDesktop, consent, logonUi });
}
// The order is the product's: the last axis varies fastest.
const AXES = [
  ['local', local],
  ['helperInstalled', [false, true]],
  ['helperConnected', [false, true]],
  ['helperDesktop', [null, 'Default', 'Winlogon', 'WINLOGON']],
  ['helperLocked', [null, false, true]],
  ['helperServiceDown', [false, true]],
  ['helperOwnedElsewhere', [false, true]],
];

const product = (axes) =>
  axes.reduce((rows, [name, values]) => rows.flatMap((row) => values.map((value) => ({ ...row, [name]: value }))), [{}]);

/** Every input's decision, as a palette of Node's distinct output objects and one palette index per input. */
function decisions() {
  const palette = [];
  const keys = new Map();
  const table = [];
  for (const inputs of product(AXES)) {
    const decision = sw.decideScreenSource(inputs);
    const key = JSON.stringify(decision);
    if (!keys.has(key)) {
      keys.set(key, palette.length);
      palette.push(decision);
    }
    table.push(keys.get(key));
  }
  return { axes: Object.fromEntries(AXES), order: AXES.map(([name]) => name), palette, table };
}

const FACTS = [
  { offer: 'none', outcome: null, detail: null, issue: null },
  { offer: 'update', outcome: 'failed', detail: 'why', issue: 'grant_expired', accountIsAdmin: false },
];
function statuses() {
  const { palette } = decisions();
  const cases = [];
  palette.forEach((decision, index) => {
    for (const controlGranted of [false, true]) {
      for (const helperVideo of [false, true]) {
        FACTS.forEach((facts, factsIndex) => {
          cases.push({ decision: index, controlGranted, helperVideo, facts: factsIndex, status: sw.screenStatusFor(decision, controlGranted, helperVideo, facts) });
        });
      }
    }
  });
  return { facts: FACTS, cases };
}

const codes = ['grant_key_missing', 'grant_expired', 'input_failed', 'desktop_unavailable', 'sas_disabled_by_policy', 'grant_required', 'grant_bad_signature', 'capture_failed', 'protocol_mismatch', ''];
const issues = [null, ...codes.slice(0, 5)];
const clientStates = product([
  ['connected', [false, true]],
  ['session', [null, 0, 2]],
  ['desktop', [null, 'Default', 'Winlogon', 'WINLOGON']],
]);
const intervals = [[], [66], [66, 66], [100, 101], [10, 20, 30], [1000], [66, 66, 66, 66], Array.from({ length: 30 }, (_, i) => 50 + i), [0, 0]];
const misc = () => ({
  helperFrameIntervalMs: cadence.HELPER_FRAME_INTERVAL_MS,
  issueCodes: codes.map((code) => ({ code, issue: sw.screenHelperIssue(code) })),
  issueAfterChange: issues.flatMap((issue) => [false, true].map((connected) => ({ issue, connected, after: sw.helperIssueAfterChange(issue, connected) }))),
  usesHelper: decisions().palette.map((decision, index) => ({ decision: index, uses: sw.decisionUsesHelper(decision) })),
  identity: clientStates.map((state) => ({
    ...state,
    identity: sw.secureDesktopIdentity({ ...sw.NO_SECURE_DESKTOP, connected: () => state.connected, session: () => state.session, desktop: () => state.desktop }),
  })),
  offers: ['not-installed', 'outdated', 'not-enrolled', 'installed', 'other-user', 'unavailable'].map((state) => ({ state, offer: install.installOfferFor(state) })),
  stall: intervals.map((list) => ({ intervals: list, stallMs: cadence.helperVideoStallMs(list) })),
});

// The three parts of the table, each its own file.
const PARTS = { decisions, statuses, misc };
await record({
  sub: 'switch',
  recorderUrl: import.meta.url,
  identity,
  only,
  entries: Object.keys(PARTS).map((name) => ({ name })),
  play: ({ name }) => ({ name, value: PARTS[name]() }),
  files: (results) => Object.fromEntries(results.map(({ name, value }) => [`${name}.json`, value])),
  committed: (read) => Object.keys(PARTS).map((name) => ({ name, value: read(`${name}.json`) })),
});
process.exit(process.exitCode ?? 0);
