// Path of the durable channel-link record (channel-remote-intent.json).
import { join } from 'node:path';
import { resolveRuntimeRoot } from './runtime-root.mjs';

export function remoteIntentPath(root = resolveRuntimeRoot()) {
  return join(root, 'channel-remote-intent.json');
}
