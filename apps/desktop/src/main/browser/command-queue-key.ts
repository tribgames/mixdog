/** The queue a command belongs to: session metadata, the visible page, or one
 *  named background page. Commands on different keys run in parallel. */
import type { BrowserCommand } from './command';
import { normalizeBackgroundTabName } from './tab-policy';

export interface QueueKeyHost {
  sessionId?(command: BrowserCommand): string;
  /** Resolve tab-less work to the selected physical page, including support tabs. */
  currentPageId?(sessionId: string): string | undefined;
  backgroundEntryByPageId(sessionId: string, pageId: string): [string, unknown] | null;
}

export function normalizedAction(command: BrowserCommand): string {
  return String(command.action || '')
    .trim()
    .toLowerCase();
}

export function commandQueueKey(host: QueueKeyHost, command: BrowserCommand): string {
  const owner = host.sessionId?.(command);
  const prefix = owner ? `session:${owner}:` : '';
  const action = normalizedAction(command);
  if (action === 'list_tabs' || action === 'downloads') return `${prefix}metadata`;
  const tab = String(
    command.tab || (command.background !== true ? host.currentPageId?.(owner ?? '') : '') || ''
  ).trim();
  if (/^p\d+$/i.test(tab)) {
    const found = host.backgroundEntryByPageId(owner ?? '', tab);
    if (found) return `${prefix}background:${found[0]}`;
    return `${prefix}foreground`;
  }
  if (command.background === true) {
    return `${prefix}background:${normalizeBackgroundTabName(tab)}`;
  }
  if (tab && !/^v\d+$/i.test(tab) && !/^p\d+$/i.test(tab)) {
    return `${prefix}background:${normalizeBackgroundTabName(tab, { required: true })}`;
  }
  return `${prefix}foreground`;
}
