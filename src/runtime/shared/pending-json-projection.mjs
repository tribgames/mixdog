// Leaf registry: a JSON file whose in-process writer persists asynchronously
// (standalone/agent-tool/index-write-queue.mjs) publishes its document-with-
// unpersisted-writes here, so other in-process readers of that same file (the
// cold session catalog) still see this process's own writes immediately.
import { resolve } from 'node:path';

const projections = new Map(); // resolved file path → () => document | null

export function registerJsonProjection(file, getProjection) {
  projections.set(resolve(file), getProjection);
}

/** Document including this process's unpersisted writes, or null when the
 *  file on disk is current. */
export function readJsonProjection(file) {
  return projections.get(resolve(file))?.() ?? null;
}
