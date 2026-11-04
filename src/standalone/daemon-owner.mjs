// The discovery file (daemon.json) a running daemon publishes, read the way
// launchers and the daemon itself read it. Who owns a data dir is not decided
// here: that is the daemon's OS lock (daemon-owner-lock.mjs).
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** daemon.json's pid and session endpoint, or null when missing/unreadable. */
function discoveryOf(parsed) {
  const session = parsed?.endpoints?.session;
  return { pid: Number(parsed?.pid) || 0, port: Number(session?.port) || 0, token: session?.token || '' };
}

export function readDiscovery(discoveryPath) {
  try {
    return discoveryOf(JSON.parse(readFileSync(discoveryPath, 'utf8')));
  } catch {
    return null;
  }
}

/** readDiscovery without blocking the event loop. */
export async function readDiscoveryAsync(discoveryPath) {
  try {
    return discoveryOf(JSON.parse(await readFile(discoveryPath, 'utf8')));
  } catch {
    return null;
  }
}

/** The pid daemon.json names, or 0 when it is missing or unreadable. */
export function discoveryPid(discoveryPath) {
  return readDiscovery(discoveryPath)?.pid || 0;
}
