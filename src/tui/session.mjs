/**
 * TUI session facade.
 *
 * Product clients receive only a daemon-owned session projection. The large
 * in-process store lives in src/standalone/local-session-runtime.mjs and is not exposed
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
  const { createSession } = await import('./protocol-session/index.mjs');
  return await createSession(options);
}
