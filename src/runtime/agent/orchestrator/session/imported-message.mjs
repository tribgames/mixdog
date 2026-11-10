/**
 * Provenance of messages carried over from another app's conversation
 * (conversation-import). Their text is prose someone wrote elsewhere: it may
 * look like a runtime reminder, a task envelope or a compaction summary, but
 * restore and the model wire treat it as plain user/assistant text. Leaf, no IO.
 */
export const IMPORTED_MESSAGE_SOURCE = 'import';

export function isImportedMessage(message) {
  return message?.meta?.source === IMPORTED_MESSAGE_SOURCE;
}
