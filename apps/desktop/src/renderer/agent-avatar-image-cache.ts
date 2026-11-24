// A custom avatar's images, one entry per agent: its file names are content
// hashes, so the entry for the current files never goes stale, and a changed
// avatar or a deleted agent releases the older data URLs.
import { agentIdOfHomeSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';

const cache = new Map<string, { files: string; images: Promise<unknown> }>();

export function cachedAgentAvatarImages<T>(agentId: string, files: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(agentId);
  if (hit?.files === files) return hit.images as Promise<T>;
  const images = load();
  cache.set(agentId, { files, images });
  return images;
}

export function forgetAgentAvatarImages(agentId: string): void {
  cache.delete(agentId);
}

/** An agent's home session deleted for good takes the agent's images with it. */
export function forgetHomeSessionAvatarImages(sessionId: string): void {
  const agentId = agentIdOfHomeSession(sessionId);
  if (agentId) cache.delete(agentId);
}
