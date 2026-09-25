// Compaction debug/diagnostic helpers.
import { summarizeContextMessages } from '../context-utils.mjs';

export { compactDebugEnabled, compactDebugLog } from '../compact/constants.mjs';

export function estimateMessagesTokensSafe(messages) {
  // summarizeContextMessages is the fingerprint-validated cached form of
  // estimateMessagesTokens (same per-message estimator, accumulated on the
  // live array). The uncached sum cost ~30ms per call on a long session and
  // ran on EVERY pre-send iteration; the cached path is ~1ms warm.
  try {
    return summarizeContextMessages(messages).estimatedTokens;
  } catch {
    return null;
  }
}
