/**
 * TUI session facade.
 *
 * Product clients receive only a daemon-owned session projection. The large
 * in-process store is isolated in session-local.mjs and is not exposed
 * from this client facade.
 */
export {
  cleanupStaleTranscriptSpillDirs,
  createTranscriptSpillBuffer,
  refillTranscriptViewOverlap,
  replaceSessionItemsState,
  createSessionItemMutators,
  TRANSCRIPT_LIVE_ITEM_CAP,
  TRANSCRIPT_SPILL_CHUNK_ITEMS,
} from './session/transcript-spill.mjs';
export { parseBackgroundTaskEnvelope } from './session/agent-envelope.mjs';

export async function createSessionRuntime(options = {}) {
  const { createSession } = await import('../standalone/session-client.mjs');
  return await createSession(options);
}
