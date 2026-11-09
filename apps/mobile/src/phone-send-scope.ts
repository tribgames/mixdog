// Which call a request frame belongs to. Node ties a call's deadline restart and silence probe to that call's own `sendApplicationFrame`
// promise (remote-shim-calls.ts:258-273). The protocol client assigns the frame itself, so the call hands it a claim: a client method run
// inside `withSendScope` passes the claim down with its request, and the connector gives the claim the promise of exactly that frame leaving.
// A call that never sends registers nothing; no frame is ever claimed by a call other than the one whose method wrote it.
import type { ProtocolClient, SentClaim } from '../../../packages/protocol-client/src/index.ts';

export type FrameClaim = SentClaim;

/** A claim that takes the first frame only: a call's own frame is the one it sends first. */
export const firstFrame = (claim: FrameClaim): FrameClaim => {
  let taken = false;
  return (sent) => {
    if (taken) return;
    taken = true;
    claim(sent);
  };
};

/** The client with every method run under `claim`. */
export function scopeClient<C extends Pick<ProtocolClient, 'withSendScope'>>(client: C, claim: FrameClaim): C {
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== 'function' || key === 'withSendScope') return value;
      return (...args: unknown[]) => target.withSendScope(claim, () => (value as (...rest: unknown[]) => unknown).apply(target, args));
    },
  });
}