// Global tool-approval shortcuts: Esc/d/n deny, a/y approve. Returns the
// decision to resolve with, or null. Question approvals (ask_user) are
// answered only inside QuestionPanel, so typed letters and Esc never reach here.
export function approvalShortcutDecision(toolApproval, input, key) {
  if (!toolApproval || toolApproval.kind === 'question') return null;
  const value = String(input || '')
    .trim()
    .toLowerCase();
  if (key.escape || value === 'd' || value === 'n') return { approved: false, reason: 'denied by user' };
  if (value === 'a' || value === 'y') return { approved: true, reason: 'approved by user' };
  return null;
}
