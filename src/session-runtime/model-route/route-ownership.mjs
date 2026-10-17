/**
 * route-ownership.mjs — who a route selection belongs to.
 *
 * A runtime holds one conversation at a time; reset, resume, new-session and
 * close replace it, or leave none. Every such transition advances the session
 * generation. A selection captures the generation when it is enqueued and
 * holds a lease on it: once the generation has moved, the selection's route
 * side effects (adopt, refresh completion, pending registration, session
 * updates, display rollback) are no-ops, and the current route stands.
 */

const sessionOwner = (session) => (session ? (session.id ?? session) : null);

/** Make `holder.session` advance `holder.sessionGeneration` whenever another
 *  conversation (or none) is installed. Re-installing the same conversation
 *  (a refreshed object for the same id) is not a transition. */
export function trackSessionGeneration(holder) {
  let session = holder.session ?? null;
  let generation = 0;
  Object.defineProperty(holder, 'session', {
    enumerable: true,
    configurable: true,
    get: () => session,
    set: (next) => {
      const installed = next ?? null;
      if (sessionOwner(installed) !== sessionOwner(session)) generation += 1;
      session = installed;
    },
  });
  Object.defineProperty(holder, 'sessionGeneration', {
    enumerable: true,
    configurable: true,
    get: () => generation,
  });
  return holder;
}

/** A selection's hold on the generation it was enqueued under. The token is
 *  compared strictly; an absent token is a token like any other. */
export function openRouteLease(getGeneration, token = getGeneration()) {
  const valid = () => getGeneration() === token;
  return {
    token,
    valid,
    /** The one way a selection touches route or session state: `effect` runs
     *  only if the lease holds at this very point, else `otherwise()` stands.
     *  Anything after an `await` (even one that resolved without error) must
     *  come through here, since a transition can run between the awaited call
     *  returning and its caller continuing. */
    run: (effect, otherwise) => (valid() ? effect() : otherwise()),
  };
}

/** A selection that is not addressed to a conversation (a default for new
 *  sessions) belongs to no session and survives every transition. */
export const UNOWNED_LEASE = Object.freeze({
  token: undefined,
  valid: () => true,
  run: (effect) => effect(),
});
