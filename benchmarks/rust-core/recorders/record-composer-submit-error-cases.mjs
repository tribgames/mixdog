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
    'op/status and the rejected-answer notification to a relay connection (mixdog-app-server/src/server.rs `op_status_reply`, outgoing.rs `response_rejected`, the refused-decision notification of `on_response`: a stored or forwarded failure is told to a relay without its text and its params, relay_answer.rs `RelayAnswer::stored`)',
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
  replay: { entry: 'the desktop relay\'s refusal frames and the composer\'s text on the product modules; compare each case whole. In Rust the frame is the server\'s error answer to a relay connection (error = data.message, errorCode = data.code, errorParams = data.detail): the refusal frames of case 1 and 2 and every answer of case 3 are replayed whole through the real server (mixdog-app-server tests/relay_answer.rs); a failed call asked again (case 4, `first` and `again`) is replayed whole from a second relay connection; the composer\'s text (namedTexts, bareTexts, otherMessage, proseWithoutCode) and the IPC leg (ipcDetails, relayDetails) are the renderer\'s and stay on the desktop', normalised: { 'the frame id': 'none: the replay sends each recorded frame\'s own id', 'ok': 'the JSON-RPC answer carries an `error` member and no `result` member exactly when Node\'s frame has ok:false', 'error / errorCode / errorParams': 'the members of the JSON-RPC error\'s `data`: message, code and detail (`name`)', 'error.code, error.message': 'the JSON-RPC error body has no member in Node\'s frame: the domain error\'s request-error code and its reason text; they are checked as those constants' } },
  exclusions: { renderer: 'namedTexts, bareTexts, otherMessage, proseWithoutCode, languages, ipcDetails, relayDetails, params: the composer text, the IPC envelope and the whitelist function are the desktop renderer\'s (apps/desktop/src/renderer/composer-submit-error.ts, shared/coded-error.ts) and stay there; the Rust whitelist is typed (a detail variant per public code) and its length rule is replayed through case 3', storedOutcome: 'case 4 `status`: Node\'s relay has no method that reads an outcome back (the frame is `unknown method`), so the core\'s `op/status` and its rejected-answer notification to a relay connection have no frame to equal; they are replayed against the invariant Node\'s frames record (`secretInFrames`: no frame carries the call\'s secret) and against the same read by a local client, from which a relay\'s differs only by the message and the detail the relay is not told (the call\'s secrets are not stored with the rejection, so nothing is redacted by them: the text is withheld). The stored rejection is staged in the mock op index (the seam of the app-server tests), not through the core\'s op gate, which mixdog-core-base replays', secretFrame: 'the first recording of the secret refusal passes the Node capability argument {key}, which is no Rust method\'s params; case 3 records the same refusal with arguments that are a Rust method\'s params ("the secret is removed from the params of a public code")' },
});
process.exit(0);
