// Which call a request frame belongs to. Node ties a call's deadline restart and silence probe to that call's own `sendApplicationFrame`
// promise (remote-shim-calls.ts:258-273). Here the call's claim travels with its request as the `sent` option of the client method, down to the
// `TransportWriter.send(text, sent)` of that exact frame, however long the method waits before writing (the connection, a digest). A call that
// never sends registers nothing, and no frame is ever claimed by a call other than the one whose method wrote it.
import type { SentClaim } from '../../../packages/protocol-client/src/index.ts';

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

/** Where each client method that writes a request takes its options argument. */
const OPTIONS_AT: Readonly<Record<string, number>> = {
  call: 2,
  resumeThread: 2,
  unsubscribeThread: 1,
  subscribeApp: 0,
  readBlob: 1,
  putBlob: 2,
};

/** The client for one call: every request-writing method gets that call's claim as its `sent` option. */
export function scopeClient<C extends object>(client: C, claim: FrameClaim): C {
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      const at = typeof key === 'string' ? OPTIONS_AT[key] : undefined;
      if (typeof value !== 'function' || at === undefined) return value;
      return (...args: unknown[]) => {
        const rest = args.slice();
        while (rest.length <= at) rest.push(undefined);
        rest[at] = { ...(rest[at] as object | undefined), sent: claim };
        return (value as (...a: unknown[]) => unknown).apply(target, rest);
      };
    },
  });
}