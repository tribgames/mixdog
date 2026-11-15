/** The client library's failure for an action whose outcome could not be learned (`opOutcomeUnknown`, packages/protocol-client): its
 *  detail names the kind, and a failure carried across a boundary that kept only the message says it as the message. The one test of
 *  it, shared by the capability lane and the renderer. */
export const isOutcomeUnknown = (error: unknown): boolean =>
  (error as { detail?: { kind?: unknown } } | null)?.detail?.kind === 'opOutcomeUnknown' ||
  (error instanceof Error && error.message === 'opOutcomeUnknown');
