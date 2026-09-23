/** Transport only lifecycle evidence. Never confuse applied artwork with visibility. */
export function computerCursorFeedback(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // `focus_masked` says the typing board withheld the keys because the focused
  // field hides its own content. It reports a decision already made, never the
  // content behind it, and carrying it here is what makes that decision checkable.
  const fields = ['system_theme_applied', 'system_theme_restored', 'pointer_moved', 'focus_masked'];
  const entries = fields
    .filter((key) => typeof record[key] === 'boolean')
    .map((key) => [key, record[key] as boolean] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}
