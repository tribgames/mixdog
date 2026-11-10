// The Node core told the phone what it serves in flags on the relay challenge (`remoteParity`, `nativePush`, `browserParity`, ...), and the
// page gates features on them. A protocol core says what it serves in `initialize.capabilities` (`remote` holds Node's flags under their
// own names), so the flags are read from there as they are. The core offers a flag only when every call it opens on this page is served
// end to end, the page's adapter included (native/core/crates/mixdog-app-protocol/src/remote_flags.json, checked against the bundled
// adapters by apps/desktop/src/renderer/remote-flags.test.mjs); a core that predates `remote` offers none.
import type { InitializeResponse } from '../../../packages/protocol-client/src/index.ts';

export interface PeerFlags {
  peerRemoteParity: boolean;
  peerNativePush: boolean;
  peerBrowserParity: boolean;
  peerBrowserDrive: boolean;
  peerBrowserSessionTabs: boolean;
  peerTermSizeOwner: boolean;
  peerHostDirectories: boolean;
  peerUsageRequests: boolean;
  peerProjectRecovery: boolean;
  peerRouteAutoEffort: boolean;
  peerVisualize: boolean;
  peerFileDownloads: boolean;
  peerSecretInput: boolean;
  peerBrowserWebrtc: number;
  peerBrowserFit: boolean;
  peerMediaE2ee: boolean;
}

export type ServerCapabilities = InitializeResponse['capabilities'];

type RemoteFlag = keyof ServerCapabilities['remote'];

export function peerFlagsOf(capabilities: ServerCapabilities): PeerFlags {
  const remote: Partial<ServerCapabilities['remote']> = capabilities.remote ?? {};
  const on = (flag: RemoteFlag): boolean => remote[flag] === true;
  return {
    peerRemoteParity: on('remoteParity'),
    peerNativePush: on('nativePush'),
    peerBrowserParity: capabilities.browser.state === 'available',
    peerBrowserDrive: on('browserDrive'),
    peerBrowserSessionTabs: on('browserSessionTabs'),
    peerTermSizeOwner: on('termSizeOwner'),
    peerHostDirectories: on('hostDirectories'),
    peerUsageRequests: on('usageRequests'),
    peerProjectRecovery: on('projectRecovery'),
    peerRouteAutoEffort: on('routeAutoEffort'),
    peerVisualize: on('visualize'),
    peerFileDownloads: on('fileDownloads'),
    peerSecretInput: on('secretInput'),
    peerBrowserWebrtc: typeof remote.browserWebrtc === 'number' ? remote.browserWebrtc : 0,
    peerBrowserFit: on('browserFit'),
    peerMediaE2ee: on('mediaE2ee'),
  };
}
