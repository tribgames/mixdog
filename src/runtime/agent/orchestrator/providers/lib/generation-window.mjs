/**
 * A stream's success result carries its own generation window: from this
 * stream's first output to its end. Usage accounting computes speed from it
 * (usage-accounting.mjs), so a retried, reconnected or fallen-back send is
 * timed by the stream that answered, never by an abandoned attempt or the
 * backoff before it. A result without one (a non-streaming recovery, a
 * stream that showed no output start) has no speed.
 */
export const generationWindow = (firstOutputAt) => (firstOutputAt ? { generationMs: Date.now() - firstOutputAt } : {});
