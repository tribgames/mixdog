// Formatting shared by every surface that hands shell output to an agent.
// Program output is untrusted text: anything shaped like a harness/system tag
// is escaped so it can never forge a notice, a result boundary or a reminder.
// (Capping lives in tools/builtin/lib/shell-delivery.mjs, per-job cursors in
// tools/builtin/lib/shell-task-output.mjs.)

// A tag-looking token: `<name`, `</name`, where the name is a known
// harness/system/transcript word or any hyphenated/underscored/namespaced
// name (task-notification, system-reminder, tool_result, ns:tag ...). Plain
// HTML-ish words like <div> or a comparison `a<b` stay readable.
const HARNESS_TAG =
  /<(\/?)(?=(?:[a-z][\w]*[-_:][\w:-]*|system|result|results|summary|status|error|user|assistant|human|tool|function|functions|instructions|context|notification|reminder|output|invoke|parameter|thinking)\b)/gi;

export function escapeHarnessTags(text) {
  return String(text ?? '').replace(HARNESS_TAG, '&lt;$1');
}

export function formatDuration(ms) {
  if (!(ms >= 0)) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}
