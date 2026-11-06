// The transcript v1.4.5's recoverTurnCheckpoint leaves on a session (turn-checkpoint.mjs:488-489),
// for the migration's splice fixtures (`splice.rs`). Run from this directory against a v1.4.5
// checkout with its node_modules:
//   node checkpoint_splice.mjs <v145>/src checkpoint_splice.cases.json > checkpoint_splice.json
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [root, casesPath] = process.argv.slice(2);
const mod = (rel) => import(pathToFileURL(join(root, 'runtime/agent/orchestrator/session/manager', rel)).href);
const { checkpointDisposition } = await mod('turn-checkpoint.mjs');
const { finalizeTurnInterruptionSnapshot } = await mod('turn-interruption.mjs');
const { stripProviderReplayMessages } = await mod('provider-replay.mjs');

// replayCheckpoint (turn-checkpoint.mjs:111-127), not exported.
function replayCheckpoint(durable, checkpoint, boundary, routeChanged) {
  const finalized =
    checkpoint.sealed === true
      ? { messages: checkpoint.turnMessages.slice(), responsePreserved: true }
      : finalizeTurnInterruptionSnapshot({
          turnOutgoing: checkpoint.turnMessages,
          currentUserContent: checkpoint.currentUserContent,
          snapshot: checkpoint.interruption,
          abortReason: 'process-crash',
        });
  const turnMessages = routeChanged ? stripProviderReplayMessages(finalized.messages) : finalized.messages;
  return checkpoint.fullTranscript === true ? turnMessages : [...durable.messages.slice(0, boundary), ...turnMessages];
}

const out = {};
for (const [name, { durable, checkpoint }] of Object.entries(JSON.parse(readFileSync(casesPath, 'utf8')))) {
  const disposition = checkpointDisposition(durable, checkpoint);
  if (disposition.action !== 'replay') {
    out[name] = { action: disposition.action };
    continue;
  }
  const routeChanged = [durable.activeTurnCheckpoint].some(
    (entry) => entry?.turnToken === checkpoint.turnToken && entry.routeChanged === true
  );
  out[name] = { action: 'replay', messages: replayCheckpoint(durable, checkpoint, disposition.boundary, routeChanged) };
}
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
