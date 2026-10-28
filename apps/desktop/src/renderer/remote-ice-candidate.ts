// ICE candidate handling the two phone-side WebRTC peers (the transport and
// the live view) share.
import type { RemoteWebrtcCandidate } from '../shared/remote-webrtc';

export interface PendingIceCandidates {
  remoteSet: boolean;
  candidates: Array<RTCIceCandidateInit | null>;
}

/** The signaled form of a gathered candidate; `null` ends the gathering. */
export function iceCandidateSignal(found: RTCIceCandidate | null): RemoteWebrtcCandidate | null {
  return found
    ? {
        candidate: found.candidate,
        sdpMid: found.sdpMid,
        sdpMLineIndex: found.sdpMLineIndex,
        usernameFragment: found.usernameFragment,
      }
    : null;
}

/** Holds the candidate until the remote description is set, then adds it. One
 *  bad candidate is not the connection's failure (ICE decides that), so a
 *  refusal only reaches `onRefused`. */
export function addIceCandidate(
  pc: RTCPeerConnection,
  pending: PendingIceCandidates,
  candidate: RTCIceCandidateInit | null,
  onRefused: (error: unknown) => void
): void {
  if (!pending.remoteSet) {
    pending.candidates.push(candidate);
    return;
  }
  pc.addIceCandidate(candidate).catch(onRefused);
}
