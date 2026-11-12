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
  protocolMethods: [
    'room/send (a refusal of a send to a switched-off member: mixdog-core-rooms/src/rooms/service.rs `failure`, written by mixdog-app-server/src/error.rs `error_data`)',
    'account/saveProviderApiKey, mcp/completeMcpOAuthLogin, connector/addConnectorAccount, mcp/saveMcpServer, approval/provideSecret (the secret-bearing calls whose refusals a phone is told with the call\'s own secrets removed: mixdog-app-server/src/relay_answer.rs `RelayAnswer`, applied in server.rs `admitted` to a relay connection\'s requests)',
  ],
  missing: [],
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
  replay: { entry: 'the desktop relay\'s refusal frames and the composer\'s text on the product modules; compare each case whole. In Rust the frame is the server\'s error answer to a relay connection (error = data.message, errorCode = data.code, errorParams = data.detail): the refusal frames of case 1 and 2 and every answer of case 3 are replayed whole through the real server (mixdog-app-server tests/relay_answer.rs); the composer\'s text (namedTexts, bareTexts, otherMessage, proseWithoutCode) and the IPC leg (ipcDetails, relayDetails) are the renderer\'s and stay on the desktop', normalised: {} },
  exclusions: { renderer: 'namedTexts, bareTexts, otherMessage, proseWithoutCode, languages, ipcDetails, relayDetails, params: the composer text, the IPC envelope and the whitelist function are the desktop renderer\'s (apps/desktop/src/renderer/composer-submit-error.ts, shared/coded-error.ts) and stay there; the Rust whitelist is typed (a detail variant per public code) and its length rule is replayed through case 3', secretFrame: 'the first recording of the secret refusal passes the Node capability argument {key}, which is no Rust method\'s params; case 3 records the same refusal with arguments that are a Rust method\'s params ("the secret is removed from the params of a public code")' },
});
process.exit(0);
