// A custom avatar's images, one entry per agent: its file names are content
// hashes, so the entry for the current files never goes stale, and a changed
// avatar or a deleted agent releases the older data URLs.
import { agentIdOfHomeSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import { registerIdleReclaim } from './idle-reclaim';
import { enforceRendererCacheBudget, registerBudgetedCache } from './renderer-cache-budget';
import { estimateRetainedChars } from './renderer-value-weight';

const AVATAR_IMAGE_MEASURE_LIMIT = 16 * 1024 * 1024;
const cache = new Map<string, { files: string; images: Promise<unknown>; chars: number }>();
let retainedChars = 0;

function deleteEntry(agentId: string): void {
  const entry = cache.get(agentId);
  if (!entry) return;
  retainedChars -= entry.chars;
  cache.delete(agentId);
}

function trimEntries(target: number): void {
  while (retainedChars > target && cache.size > 0) {
    deleteEntry(cache.keys().next().value as string);
  }
}

function clearEntries(): void {
  cache.clear();
  retainedChars = 0;
}

registerBudgetedCache({
  name: 'agent-avatar-images',
  chars: () => retainedChars,
  trim: trimEntries,
});
registerIdleReclaim(clearEntries);

export function cachedAgentAvatarImages<T>(agentId: string, files: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(agentId);
  if (hit?.files === files) {
    cache.delete(agentId);
    cache.set(agentId, hit);
    return hit.images as Promise<T>;
  }
  deleteEntry(agentId);
  const images = load();
  const baseChars = agentId.length + files.length;
  const entry = { files, images, chars: baseChars };
  cache.set(agentId, entry);
  retainedChars += baseChars;
  void images.then(
    (value) => {
      if (cache.get(agentId) !== entry) return;
      const nextChars = baseChars + estimateRetainedChars(value, AVATAR_IMAGE_MEASURE_LIMIT);
      retainedChars += nextChars - entry.chars;
      entry.chars = nextChars;
      enforceRendererCacheBudget();
    },
    () => {
      if (cache.get(agentId) === entry) deleteEntry(agentId);
    }
  );
  return images;
}

export function forgetAgentAvatarImages(agentId: string): void {
  deleteEntry(agentId);
}

/** An agent's home session deleted for good takes the agent's images with it. */
export function forgetHomeSessionAvatarImages(sessionId: string): void {
  const agentId = agentIdOfHomeSession(sessionId);
  if (agentId) deleteEntry(agentId);
}
