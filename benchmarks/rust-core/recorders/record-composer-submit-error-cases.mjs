#!/usr/bin/env node
// Recording of apps/desktop/src/renderer/composer-submit-error.test.mjs (b6f10295a): a send to a switched-off room member shows the
// refusal in the UI language, whether the error arrived over IPC or as a relay frame (the frame a phone receives is recorded whole);
// an error's display params are whitelisted strings, and the relay redacts them like the message.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-composer-submit-error-cases.mjs --tree <export of b6f10295a with node_modules>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';
import { composerErrorScenarios } from './lib/composer-error-scenarios.mjs';

REPLAY_TARGETS['composer-submit-error-cases'] = {
  missing: ['the error envelope a phone receives for a refused send (error text, errorCode, errorParams, redaction of a secret-bearing refusal): built by the desktop relay (apps/desktop/src/main/remote-methods.ts executeRemoteFrame); the Rust core carries the refusal\'s code, message and typed detail (the member\'s name) to its client (mixdog-app-server/src/error.rs:138; mixdog-core-rooms/src/rooms/service.rs:187), no phone-facing envelope of its own'],
};
const set = openSet('composer-submit-error-cases', import.meta.url);
const modules = {
  i18n: (await set.load('apps/desktop/src/renderer/i18n.ts')).default,
  ...(await set.load('apps/desktop/src/renderer/composer-submit-error.ts')),
  ...(await set.load('apps/desktop/src/shared/coded-error.ts')),
  ...(await set.load('apps/desktop/src/shared/room-error-codes.ts')),
  ...(await set.load('apps/desktop/src/main/remote-methods.ts')),
  ...(await set.load('apps/desktop/src/renderer/remote-shim-dispatch.ts')),
  ...(await set.load('apps/desktop/src/shared/ui-language.ts')),
  readLocale: (value) => JSON.parse(readFileSync(join(set.tree, 'apps/desktop/src/renderer/locales', `${value}.json`), 'utf8')),
};
// The phone page's own decoder of a relay answer (remote-shim-dispatch.ts handleMessage), installed on a context holding only what an answer
// frame touches: the pending call it settles.
const decodeRelayFrame = (frame) => new Promise((resolve) => {
  const ctx = { awaitingPong: false, pending: new Map([[frame.id, { reject: resolve }]]), settleCallCredit: () => {} };
  modules.installRemoteDispatch(ctx);
  ctx.handleMessage(frame, true);
});
for (const [name, scenario] of Object.entries(composerErrorScenarios({ ...modules, decodeRelayFrame }))) await set.run(name, scenario);

await set.finish({
  entry: { runs: 'composerSubmitErrorText (renderer), codedErrorParams / ipcErrorEnvelope / ipcErrorFromEnvelope (shared/coded-error.ts), roomMemberSwitchedOffError, executeRemoteFrame (main/remote-methods.ts) with a scripted host that throws, i18n with the catalogs of every supported language', notRun: 'no real room: the host\'s send throws the refusal', hops: 'The relay frame (the object executeRemoteFrame returns for a phone) is recorded whole; the phone\'s JSON text is its JSON.stringify.' },
  replay: { entry: 'the desktop relay\'s refusal frames and the composer\'s text on the product modules; compare each case whole', normalised: {} },
});
process.exit(0);
