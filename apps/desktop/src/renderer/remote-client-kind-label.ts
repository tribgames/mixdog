import type { RemoteClientKind } from '../shared/remote-trust';
import { t } from './i18n';

/** What kind of Mixdog client a remote device is, in the user's words. */
export function kindLabel(kind: RemoteClientKind): string {
  if (kind === 'app') return t('Mixdog app');
  if (kind === 'pc') return t('Mixdog PC');
  return t('Browser');
}

/** The kind (app / desktop / browser name) is shown beside the title, so a
 *  trailing " · <kind>" in the stored name is dropped. */
export function deviceTitle(
  client: { name?: string; platform?: string; browser?: string },
  kind: RemoteClientKind
): string {
  const full = client.name || `${client.platform || t('Device')} · ${client.browser || t('Browser')}`;
  const parts = full.split(' · ');
  const last = parts[parts.length - 1].toLowerCase();
  const kinds = [client.browser, kindLabel(kind), 'Mixdog App', 'Mixdog Desktop', 'Mixdog PC'];
  if (parts.length > 1 && kinds.some((value) => value && value.toLowerCase() === last)) parts.pop();
  return parts.join(' · ');
}

/** The kind text shown with a device: the browser's own name for browsers. */
export function deviceKindText(client: { browser?: string }, kind: RemoteClientKind): string {
  return kind === 'browser' && client.browser ? client.browser : kindLabel(kind);
}
