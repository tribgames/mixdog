// A hard-deleted session takes its conversation transcript
// (`<home>/projects/<slug>/<id>.jsonl`) and the memory ingest read positions
// keyed by that file with it. Registered once per process as a store purge hook:
// the file removal is synchronous under the delete's commit lock, the offset
// removal is a best-effort request to the memory service.
import { registerSessionPurgeHook } from '../runtime/agent/orchestrator/session/store.mjs';
import { mixdogHome } from '../runtime/shared/plugin-paths.mjs';
import { purgeSessionTranscripts } from '../runtime/shared/transcript-writer/purge.mjs';

const logError = (message) => {
  try {
    process.stderr.write(`mixdog: transcript-purge: ${message}\n`);
  } catch {
    /* logging is best effort */
  }
};

/** @param {{ forgetOffsets?: (transcriptPaths: string[]) => Promise<unknown> }} options */
export function registerTranscriptPurgeHook({ forgetOffsets } = {}) {
  return registerSessionPurgeHook((sessionId, context) => {
    const transcriptPaths = purgeSessionTranscripts({
      mixdogHome: mixdogHome(),
      sessionId,
      cwds: context?.cwds,
      onError: (target, error) => logError(`could not remove ${target}: ${error?.message || error}`),
    });
    if (!transcriptPaths.length || typeof forgetOffsets !== 'function') return;
    Promise.resolve()
      .then(() => forgetOffsets(transcriptPaths))
      .catch((error) => logError(`could not drop ingest offsets of ${sessionId}: ${error?.message || error}`));
  });
}
