import { contextBridge } from 'electron';

import { REMOTE_HOST_ARGUMENT } from '../shared/remote-window';

// The "Connect to another PC" window loads the host's relay web app, which runs
// on the remote shim. This preload deliberately exposes NO desktop bridge: only
// which host the window shows, so the page can name it in its chrome and
// identify its pairing claim as a desktop client.
function readHost(): { hostId: string; hostName: string } | null {
  const argument = process.argv.find((value) => value.startsWith(REMOTE_HOST_ARGUMENT));
  if (!argument) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(argument.slice(REMOTE_HOST_ARGUMENT.length))) as {
      id?: unknown;
      name?: unknown;
    };
    return { hostId: String(parsed.id ?? '').slice(0, 64), hostName: String(parsed.name ?? '').slice(0, 80) };
  } catch {
    return null;
  }
}

const host = readHost();
if (host) contextBridge.exposeInMainWorld('mixdogRemoteWindow', Object.freeze(host));
