/** The client library's failure for an action whose outcome could not be learned (`opOutcomeUnknown`, packages/protocol-client), by its
 *  detail: the one test of it, shared by the capability lane and the renderer. Across IPC only the message survives, and that is the
 *  sentence main made for it (main/protocol/client-failure-text.ts). */
export const isOutcomeUnknown = (error: unknown): boolean =>
  (error as { detail?: { kind?: unknown } } | null)?.detail?.kind === 'opOutcomeUnknown';

/** The client library's failure for an action the core fenced before it ran (`opNotApplied`): it never ran and never will, so
 *  issuing it again is a new action, not a repeat. */
export const isNotApplied = (error: unknown): boolean =>
  (error as { detail?: { kind?: unknown } } | null)?.detail?.kind === 'opNotApplied';

/** `send()`, and once more as a new op when the core answers that it fenced the first before it ran. A second fence is the caller's
 *  failure: a link that keeps dropping is not waited out here. */
export async function reissuedOnceIfNotApplied<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!isNotApplied(error)) throw error;
    return send();
  }
}
