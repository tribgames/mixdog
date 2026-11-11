// Child of record-session-restart-prefix.mjs: what a client reads of the stored session once its scenario has ended. Node's cold session
// read (`session.read` of a session no daemon holds, src/standalone/session-service/session-calls/session-views.mjs readSession ->
// storedSessionProjection -> store-summary-reader.mjs readStoredSessionTranscript) over the data directory the phases left.
//
//   node --import determinism-preload.mjs restart-read-probe.mjs <srcDir> <dataDir> <sessionId> <outFile>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [src, dataDir, sessionId, outFile] = process.argv.slice(2);
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const { readStoredSessionTranscript } = await import(pathToFileURL(join(src, 'runtime/agent/orchestrator/session/store-summary-reader.mjs')).href);
writeFileSync(outFile, JSON.stringify(await readStoredSessionTranscript(sessionId, {})));
process.exit(0);
