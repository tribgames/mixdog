// The relay shim's live-view WebRTC members (shared/remote-webrtc.ts): present
// on a paired phone's api only, and only while the connected host advertised
// `browserWebrtc`. The desktop's own preload has none of them.
import type { DesktopApi, DesktopRemoteBrowserControl } from '../shared/contract';
import {
  REMOTE_WEBRTC_VERSION,
  type RemoteWebrtcClientSignal,
  type RemoteWebrtcDesktopSignal,
  type RemoteWebrtcRelayInputOrder,
} from '../shared/remote-webrtc';

export interface RemoteWebrtcBridge {
  /** REMOTE_WEBRTC_VERSION when the current host serves the contract, else 0. */
  remoteBrowserWebrtc?: number;
  /** `browserRemoteWebrtcSignal([signal])` on the relay. */
  remoteBrowserWebrtcSignal?(signal: RemoteWebrtcClientSignal): Promise<void>;
  /** The host's `browserRemoteWebrtc` pushes to this client, validated. */
  onRemoteBrowserWebrtc?(listener: (signal: RemoteWebrtcDesktopSignal) => void): () => void;
  /** `browserRemoteControl([sessionId, control, order])`: ordered relay input. */
  remoteBrowserControlOrdered?(
    sessionId: string,
    input: DesktopRemoteBrowserControl,
    order: RemoteWebrtcRelayInputOrder
  ): Promise<unknown>;
}

export type RemoteWebrtcApi = DesktopApi & RemoteWebrtcBridge;

/** Whether the current host advertised `browserFit` (REMOTE_BROWSER_FIT_CAPABILITY):
 *  it honours a take-over's `fit` and marks its frames `fitSettled`/`fitFailed`.
 *  'unknown' while the relay has no authenticated host (disconnected); the
 *  desktop's own api has no member, so it is 'unsupported' there.
 *  Read per use: a reconnect may reach another host. */
export function remoteBrowserFitState(api: DesktopApi | undefined): 'supported' | 'unsupported' | 'unknown' {
  const value = (api as { remoteBrowserFit?: boolean | null } | undefined)?.remoteBrowserFit;
  return value === true ? 'supported' : value === null ? 'unknown' : 'unsupported';
}

/** Read per use: a reconnect may reach another host. */
export function remoteWebrtcHost(api: DesktopApi | undefined): api is RemoteWebrtcApi {
  const bridge = api as RemoteWebrtcApi | undefined;
  return (
    bridge?.remoteBrowserWebrtc === REMOTE_WEBRTC_VERSION &&
    typeof bridge.remoteBrowserWebrtcSignal === 'function' &&
    typeof bridge.onRemoteBrowserWebrtc === 'function' &&
    typeof bridge.remoteBrowserControlOrdered === 'function'
  );
}
