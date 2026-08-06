/**
 * TUI engine facade.
 *
 * Product clients receive only a daemon-owned session projection. The large
 * in-process store is isolated in engine-local-session.mjs and is not exposed
 * from this client facade.
 */
export {
  cleanupStaleTranscriptSpillDirs,
  createTranscriptSpillBuffer,
  refillTranscriptViewOverlap,
  replaceEngineItemsState,
  createEngineItemMutators,
  TRANSCRIPT_LIVE_ITEM_CAP,
  TRANSCRIPT_SPILL_CHUNK_ITEMS,
} from './engine/transcript-spill.mjs';
export { parseBackgroundTaskEnvelope } from './engine/agent-envelope.mjs';

export async function createEngineSession(options = {}) {
  const { createRemoteEngineSession } = await import('../standalone/engine-daemon-client.mjs');
  return await createRemoteEngineSession(options);
}
