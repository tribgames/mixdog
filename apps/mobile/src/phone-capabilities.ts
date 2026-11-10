// The Node core told the phone what it serves in flags on the relay challenge (`remoteParity`, `nativePush`, `browserParity`, ...), and the
// page gates features on them. A protocol core says what it serves in `initialize.capabilities` (`remote` holds Node's flags under their
// own names), so the flags are read from there. A flag is on only when the core serves its feature AND the page's adapters answer every
// call the flag opens (`FLAG_CALLS`): a call no adapter claims would fail, so until its adapter lands the page reads the flag as off,
// the way it read a PC that did not offer it.
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

/** The Node calls each flag opens on the page (remote-shim-api.ts and its readers); a flag with none opens no call. */
export const FLAG_CALLS: Readonly<Record<RemoteFlag, readonly string[]>> = {
  remoteParity: [
    'getUpdaterState',
    'checkForDesktopUpdate',
    'showDesktopUpdate',
    'trashProjectEntry',
    'browserReleasePage',
    'submitToSession',
    'localPageUrl',
    'previewProjectFile',
    'previewProjectFileRange',
    'githubCliLoginOpenBrowser',
    'ghPrList',
    'ghPrDefaultBranch',
    'ghPrCreate',
    'ghPrView',
    'ghPrCheckout',
    'ghPrMerge',
    'ghPrDiff',
  ],
  nativePush: ['registerNativePush', 'removeNativePush'],
  browserDrive: ['browserRemoteControl'],
  browserSessionTabs: ['browserRemoteTabOpen', 'browserRemoteTabClose'],
  termSizeOwner: ['termResize'],
  hostDirectories: ['listHostDirectories'],
  usageRequests: ['readCapabilities'],
  projectRecovery: ['projectRecovery'],
  routeAutoEffort: ['submitNewTask', 'setModelRoute', 'inheritSession'],
  visualize: ['visualizeState', 'visualizeCommand', 'visualizePaneInline', 'visualizePanePages', 'visualizePaneRange'],
  fileDownloads: ['fileDownloadAuthorize', 'fileDownloadBegin', 'fileDownloadRange', 'fileDownloadFinish', 'fileDownloadAbort'],
  secretInput: ['provideSecretInput'],
  browserWebrtc: ['browserRemoteControl'],
  browserFit: ['browserRemoteControl'],
  mediaE2ee: [],
};

/** `claims(method)`: an adapter of this page answers the Node call `method` (remote-shim-protocol.ts). */
export function peerFlagsOf(capabilities: ServerCapabilities, claims: (method: string) => boolean = () => false): PeerFlags {
  const remote: Partial<ServerCapabilities['remote']> = capabilities.remote ?? {};
  const on = (flag: RemoteFlag): boolean => remote[flag] === true && FLAG_CALLS[flag].every(claims);
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
    peerBrowserWebrtc: typeof remote.browserWebrtc === 'number' && remote.browserWebrtc > 0 && FLAG_CALLS.browserWebrtc.every(claims) ? remote.browserWebrtc : 0,
    peerBrowserFit: on('browserFit'),
    peerMediaE2ee: on('mediaE2ee'),
  };
}
