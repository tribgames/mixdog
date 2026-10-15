const LOCAL_PROVIDER_DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60_000;
const TRANSPORT_COMPLETION_GRACE_MS = 5 * 60_000;

const LOCAL_PROVIDER_INSTALL_REQUEST_TIMEOUT_MS = LOCAL_PROVIDER_DOWNLOAD_TIMEOUT_MS + TRANSPORT_COMPLETION_GRACE_MS;

// Carrying a conversation into a heir compacts it for that model first: one
// summarization pass over the whole transcript, which outlives the deadline
// sized for interactive calls.
const SESSION_INHERIT_REQUEST_TIMEOUT_MS = 10 * 60_000;

// A /btw side question is one model response at the session's own effort; a
// high-effort answer can think past the interactive deadline.
const SIDE_QUESTION_REQUEST_TIMEOUT_MS = 10 * 60_000;

// Built-in dependency installs run inside their own budgets: winget/brew get
// up to 20 minutes (LibreOffice is ~350 MB) and the voice model alone has a
// 20-minute download window. The request must outlive the longest of them.
const DEPENDENCY_INSTALL_REQUEST_TIMEOUT_MS = 30 * 60_000 + TRANSPORT_COMPLETION_GRACE_MS;
const DEPENDENCY_INSTALL_OPERATIONS = new Set(['installGitCli', 'installGithubCli', 'installLibreOffice']);

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
  // Every other built-in Install downloads too (the Memory embedding model,
  // Office fonts), as do the guided system installs and turning Voice on.
  if (
    method === 'installBuiltinFeature' ||
    DEPENDENCY_INSTALL_OPERATIONS.has(method) ||
    (method === 'toggleVoice' && args[0] === true)
  ) {
    return DEPENDENCY_INSTALL_REQUEST_TIMEOUT_MS;
  }
  if (method === 'inheritFrom') return SESSION_INHERIT_REQUEST_TIMEOUT_MS;
  if (method === 'askSide') return SIDE_QUESTION_REQUEST_TIMEOUT_MS;
  return undefined;
}
