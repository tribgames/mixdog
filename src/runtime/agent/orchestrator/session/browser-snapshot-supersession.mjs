const SNAPSHOT_RE = /(?:^|\n)Snapshot:\s+(p\d+)-s\d+\b/i;

export const BROWSER_SNAPSHOT_SUPERSEDED =
  '[Browser snapshot superseded — a newer snapshot for this page exists later in the conversation. '
  + 'Use refs from the latest snapshot or call browser snapshot/observe again.]';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && Array.isArray(content.content)) {
    return contentText(content.content);
  }
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text')
    .map((part) => String(part.text || ''))
    .join('\n');
}

export function supersedeBrowserSnapshots(messages) {
  if (!Array.isArray(messages) || messages.length < 2) {
    return { messages, replaced: 0, savedBytes: 0 };
  }
  const browserCallIds = new Set();
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue;
    for (const call of message.toolCalls) {
      const name = String(call?.name || call?.function?.name || '').toLowerCase();
      if (name === 'browser' && call?.id) browserCallIds.add(call.id);
    }
  }
  const locations = [];
  const latestByPage = new Map();
  messages.forEach((message, index) => {
    if (message?.role !== 'tool') return;
    if (browserCallIds.size > 0 && !browserCallIds.has(message.toolCallId)) return;
    const text = contentText(message.content);
    const match = SNAPSHOT_RE.exec(text);
    if (!match) return;
    const pageId = match[1].toLowerCase();
    locations.push({ index, pageId, text });
    latestByPage.set(pageId, index);
  });
  const stale = locations.filter((entry) => latestByPage.get(entry.pageId) !== entry.index);
  if (!stale.length) return { messages, replaced: 0, savedBytes: 0 };
  const projected = messages.slice();
  let savedBytes = 0;
  for (const entry of stale) {
    const original = messages[entry.index];
    const replacement = `${BROWSER_SNAPSHOT_SUPERSEDED} (${entry.pageId})`;
    savedBytes += Math.max(0, Buffer.byteLength(entry.text) - Buffer.byteLength(replacement));
    projected[entry.index] = {
      ...original,
      content: replacement,
      meta: {
        ...(original?.meta && typeof original.meta === 'object' ? original.meta : {}),
        browserSnapshotSuperseded: true,
      },
    };
  }
  return { messages: projected, replaced: stale.length, savedBytes };
}
