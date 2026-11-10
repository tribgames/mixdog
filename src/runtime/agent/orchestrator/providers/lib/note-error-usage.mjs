import { noteAbandonedUsage } from '../../../../shared/llm/usage-context.mjs';

// A retry/fallback decision discards the failed attempt; record the usage the
// provider reported on its error (never an estimate) on the current send.
// Call only from the send's own awaited flow, never from stream callbacks.
export const noteErrorUsage = (err) =>
  noteAbandonedUsage(err?.partialUsage ?? err?.usage, err?.partialModel ?? err?.model);
