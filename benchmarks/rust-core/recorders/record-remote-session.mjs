#!/usr/bin/env node
// `hostState.remoteSession`: what Node's `SessionHostPublication.applyRemoteSessionState` stamps on a snapshot
// (`remoteEnabled`, `remoteSessionId`) for the channel bridge's state. Each case is the state applied to a fresh publication
// and the shell snapshot it then published.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-remote-session.mjs --tree <exact b6f10295a export>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, exactProductIdentity, importFrom, parseArgs, resolveTree, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { SessionHostPublication } = await importFrom(tree, 'apps/desktop/src/main/session-host-publication.ts');

const owner = {
  isDisposed: () => false,
  visibleSessionIds: () => new Set(),
  snapshotWithShellJobs: (_id, snapshot) => snapshot,
  trackShellJobsEngineState: () => {},
  onShellPublished: () => {},
};
const states = [
  ['enabled with a session id', { enabled: true, sessionId: 'phone_1' }],
  ['disabled', { enabled: false, sessionId: 'phone_1' }],
  ['enabled missing', { sessionId: 'phone_1' }],
  ['enabled with no session', { enabled: true, sessionId: null }],
  ['empty session id', { enabled: true, sessionId: '' }],
  ['256 characters', { enabled: true, sessionId: 'a'.repeat(256) }],
  ['257 characters', { enabled: true, sessionId: 'a'.repeat(257) }],
  ['a space in the id', { enabled: true, sessionId: 'phone 1' }],
  ['a dot in the id', { enabled: true, sessionId: 'phone.1' }],
  ['a dash and underscore', { enabled: true, sessionId: 'Phone-1_x' }],
  ['a non-ASCII id', { enabled: true, sessionId: '폰_1' }],
];
const cases = states.map(([name, state]) => {
  const publication = new SessionHostPublication(owner);
  const shells = [];
  publication.subscribe((snapshot) => shells.push(snapshot));
  publication.applyRemoteSessionState(state);
  publication.publishShell({ sessionId: '', items: [], queued: [] });
  const shell = shells.at(-1);
  return { name, state, remoteEnabled: shell.remoteEnabled, remoteSessionId: shell.remoteSessionId };
});
const dir = join(FIXTURES_ROOT, 'phone-chat-core');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'remote-session.json'), `${JSON.stringify({ recorder: 'benchmarks/rust-core/recorders/record-remote-session.mjs', cases }, null, 2)}\n`);
console.log(`recorded ${cases.length} cases`);
// Both recorders write this set; whichever runs last lists every file in the manifest.
writeSetManifest(join(FIXTURES_ROOT, 'phone-chat-core'), { set: 'phone-chat-core', recorder: 'benchmarks/rust-core/recorders/record-phone-chat-core.mjs + record-remote-session.mjs + record-room-reset.mjs', command: 'node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/<recorder>.mjs --tree <tree>, for each of the three recorders', identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146') });
