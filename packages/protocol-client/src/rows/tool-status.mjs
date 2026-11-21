export function normalizeToolTerminalStatus(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  if (/^(running|pending|queued|in_progress|in-progress)$/.test(raw)) return 'running';
  if (/^(completed|complete|done|success|succeeded|ok)$/.test(raw)) return 'completed';
  if (/^(failed|fail|error|errored|timeout|timed_out|killed)$/.test(raw)) return 'failed';
  // Task control answers `cancel-unconfirmed` when a delivered cancel's process exit is unconfirmed.
  if (/^(cancelled|canceled|cancel|cancel[-_ ]unconfirmed|cancel[-_ ]pending|cancelling|canceling)$/.test(raw))
    return 'cancelled';
  if (/^(denied|deny|refused|rejected)$/.test(raw)) return 'denied';
  return '';
}

export function leadingResultBlock(text) {
  const lines = String(text || '').split('\n');
  let index = 0;
  if (/^\[tool output offloaded:/i.test(String(lines[0] || '').trim())) {
    index = 1;
    while (index < lines.length && !lines[index].trim()) index += 1;
  }
  const block = [];
  for (; index < lines.length && lines[index].trim(); index += 1) block.push(lines[index]);
  return block.join('\n');
}

// The user taking over the browser/desktop, or the session cancelling a
// computer command, stops the call on purpose; it is not a failed invocation.
const USER_CONTROL_CANCELLATION_RE =
  /^(?:Error:\s*)?(?:Browser command interrupted by local user input\.|computer_session_aborted:|computer_user_control_active:)/i;

export function isUserControlCancellation(text) {
  return USER_CONTROL_CANCELLATION_RE.test(String(text || '').trimStart());
}

// A non-zero exit the tool itself marked as a signal (search no-match, a
// `git diff --exit-code` difference, a `git merge-tree` conflict report) rather
// than a command failure.
export function hasBenignExitOutcome(text) {
  return /^\[outcome:\s*(?:no-match|no-change|conflicts)\]\s*$/im.test(String(text || ''));
}

// The status a task/bridge envelope reports in its leading block. A `<status>`
// tag only counts when the result opens with the envelope's own tags.
const ENVELOPE_TAG_HEAD_RE = /^<(?:task-notification|task-id|tool-use-id|output-file|status)[\s>]/i;

export function toolResultEnvelopeStatus(text) {
  const head = leadingResultBlock(String(text || ''));
  if (ENVELOPE_TAG_HEAD_RE.test(head.trimStart())) {
    const tagged = head.match(/<status[^>]*>([\s\S]*?)<\/status>/i)?.[1]?.trim();
    if (tagged) return normalizeToolTerminalStatus(tagged);
  }
  const bracketed = head.match(/^\[status:\s*([^\]]*)\]/im)?.[1]?.trim();
  if (bracketed) return normalizeToolTerminalStatus(bracketed);
  const inline = head.match(/^(?:status|state):\s*([^\s·,;]+)/im)?.[1]?.trim();
  return normalizeToolTerminalStatus(inline);
}

/** Bodies the runtime itself writes when a call is stopped or aborted. */
export function toolResultControlStatus(text) {
  const body = String(text || '');
  if (isUserControlCancellation(body)) return 'cancelled';
  // Bare control bodies written on cancel/crash (current + legacy).
  const trimmed = body.trim();
  if (/^(?:cancelled|canceled)$/i.test(trimmed)) return 'cancelled';
  if (
    /^(?:interrupted by (?:user|process restart)|tool execution aborted|\[tool execution was interrupted\])$/i.test(
      trimmed
    )
  ) {
    return 'cancelled';
  }
  if (/^the user doesn't want to proceed with this tool use\b/i.test(trimmed)) return 'cancelled';
  return '';
}

export function toolResultTerminalStatus(text) {
  return toolResultEnvelopeStatus(text) || toolResultControlStatus(text);
}
