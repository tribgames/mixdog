/**
 * Shared terminal-status parsing for tool result surfaces.
 *
 * A terminal result status describes the tool's reported outcome; it is not
 * evidence that the tool invocation itself failed. Call-failure accounting is
 * owned by the TUI engine's isError/toolKind envelope fields.
 */
export function normalizeToolTerminalStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/^(running|pending|queued|in_progress|in-progress)$/.test(raw)) return 'running';
  if (/^(completed|complete|done|success|succeeded|ok)$/.test(raw)) return 'completed';
  if (/^(failed|fail|error|errored|timeout|timed_out|killed)$/.test(raw)) return 'failed';
  if (/^(cancelled|canceled|cancel)$/.test(raw)) return 'cancelled';
  if (/^(denied|deny|refused|rejected)$/.test(raw)) return 'denied';
  return '';
}

export function toolResultTerminalStatus(text) {
  const body = String(text || '');
  const tagged = body.match(/<status[^>]*>([\s\S]*?)<\/status>/i)?.[1]?.trim();
  if (tagged) return normalizeToolTerminalStatus(tagged);
  const bracketed = body.match(/^\[status:\s*([^\]]*)\]/mi)?.[1]?.trim();
  if (bracketed) return normalizeToolTerminalStatus(bracketed);
  const inline = body.match(/^(?:status|state):\s*([^\s·,;]+)/mi)?.[1]?.trim();
  const fromInline = normalizeToolTerminalStatus(inline);
  if (fromInline) return fromInline;
  // Bare control bodies written on cancel/crash (current + legacy).
  const trimmed = body.trim();
  if (/^(?:cancelled|canceled)$/i.test(trimmed)) return 'cancelled';
  if (/^(?:interrupted by (?:user|process restart)|tool execution aborted|\[tool execution was interrupted\])$/i.test(trimmed)) {
    return 'cancelled';
  }
  if (/^the user doesn't want to proceed with this tool use\b/i.test(trimmed)) return 'cancelled';
  return '';
}
