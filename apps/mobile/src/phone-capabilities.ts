// The Node core told the phone what it serves in flags on the relay challenge (`remoteParity`, `nativePush`, `browserParity`, ...), and the
// page gates features on them. A protocol core says what it serves in `initialize.capabilities`, so the flags are read from there.
// A flag with no capability behind it is false, the way the page read a PC that did not offer it; `PEER_FLAGS_WITHOUT_CAPABILITY`
// is that list, each with what the flag meant, for the core to grow a capability for (or for the page to stop gating on).
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

export function peerFlagsOf(capabilities: ServerCapabilities): PeerFlags {
  return {
    peerRemoteParity: false,
    peerNativePush: false,
    peerBrowserParity: capabilities.browser.state === 'available',
    peerBrowserDrive: false,
    peerBrowserSessionTabs: false,
    // The core serves Node's size-owner claim model (`terminal/resize` with `claim`, `own` per connection).
    peerTermSizeOwner: true,
    peerHostDirectories: false,
    peerUsageRequests: false,
    // Every core serves `projectFs/recovery` (the phone's `projectRecovery`, remote-protocol-attachments.ts), as every Node PC of this
    // release offered it (remote-relay-client-lifecycle.ts:133).
    peerProjectRecovery: true,
    peerRouteAutoEffort: false,
    peerVisualize: false,
    peerFileDownloads: false,
    peerSecretInput: false,
    peerBrowserWebrtc: 0,
    peerBrowserFit: false,
    peerMediaE2ee: false,
  };
}

/** Node challenge flags the core's `initialize.capabilities` has no entry for, and what each one gated. */
export const PEER_FLAGS_WITHOUT_CAPABILITY: Readonly<Record<string, string>> = {
  remoteParity: 'the PC serves this release\'s remote methods: update/preview/ghPr* members of the DesktopApi table',
  nativePush: 'registerNativePush for the phone app\'s APNs/FCM token',
  browserDrive: 'the remote browser pane may send the `viewport` control',
  browserSessionTabs: 'a conversation browser\'s tabs ride its frames and its tab controls are accepted',
  termSizeOwner: 'termResize honors the size-owner flag (0x0 release, owner heartbeats)',
  hostDirectories: 'listHostDirectories (the folder browser)',
  usageRequests: 'getUsageRequests',
  projectRecovery: 'projectRecovery calls',
  routeAutoEffort: 'autoEffort in model selections and +noauto automation refs',
  visualize: 'the agent visualize panel: state, tab commands, pane reads',
  fileDownloads: 'the host file download lane',
  secretInput: 'a handoff secret typed on the phone',
  browserWebrtc: 'WebRTC live view of the remote browser (RS-2)',
  browserFit: 'a take-over\'s fit is honored and frames are marked',
  mediaE2ee: 'the encrypted HTTP media lane (RS-1)',
};
