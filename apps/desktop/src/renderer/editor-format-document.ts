const FORMAT_DOCUMENT = 'editor.action.formatDocument';

export type FormatDocumentOutcome = 'formatted' | 'unchanged' | 'unavailable';

type FormatTarget = {
  getAction(id: string): { isSupported(): boolean; run(): Promise<void> } | null;
  getModel(): { getVersionId(): number } | null;
};

/** The Format item is offered only when a formatter really exists for the
 *  model's language: the server declared formatting for the open file AND the
 *  Monaco provider for that language was installed. Either alone is not enough
 *  (a stale capability snapshot, or a provider whose server is gone). */
export function documentFormatterAvailable(
  capabilities: { formatting?: boolean } | null | undefined,
  providerInstalled: boolean
): boolean {
  return Boolean(capabilities?.formatting) && providerInstalled;
}

/** Monaco's `run()` resolves silently when the action's precondition is false
 *  or the formatter returns no edits, so the outcome is derived explicitly:
 *  applied edits always bump the model version. */
export async function runFormatDocument(editor: FormatTarget): Promise<FormatDocumentOutcome> {
  const action = editor.getAction(FORMAT_DOCUMENT);
  const model = editor.getModel();
  if (!action || !model || !action.isSupported()) return 'unavailable';
  const before = model.getVersionId();
  await action.run();
  return model.getVersionId() === before ? 'unchanged' : 'formatted';
}
