const LOCAL_PROVIDER_DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60_000;
const TRANSPORT_COMPLETION_GRACE_MS = 5 * 60_000;

const LOCAL_PROVIDER_INSTALL_REQUEST_TIMEOUT_MS = LOCAL_PROVIDER_DOWNLOAD_TIMEOUT_MS + TRANSPORT_COMPLETION_GRACE_MS;

// Carrying a conversation into a heir compacts it for that model first: one
// summarization pass over the whole transcript, which outlives the deadline
// sized for interactive calls.
const SESSION_INHERIT_REQUEST_TIMEOUT_MS = 10 * 60_000;

/** Deadline for the few calls that legitimately outlive an interactive
 *  request. Everything else keeps the ordinary request timeout. */
export function longRunningRequestTimeout(method: string, args: unknown[] = []): number | undefined {
  if (method === 'installLocalProviderModel') {
    return LOCAL_PROVIDER_INSTALL_REQUEST_TIMEOUT_MS;
  }
  // Code Tidy's built-in install downloads its core managed engines
  // (~130 MB); it needs the same download-sized deadline, not the
  // interactive one.
  if (method === 'installBuiltinFeature' && (args[0] === 'localProvider' || args[0] === 'tidy')) {
    return LOCAL_PROVIDER_INSTALL_REQUEST_TIMEOUT_MS;
  }
  if (method === 'inheritFrom') return SESSION_INHERIT_REQUEST_TIMEOUT_MS;
  return undefined;
}
