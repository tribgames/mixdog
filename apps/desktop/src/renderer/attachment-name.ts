import { t } from './i18n';

/** The name a pasted or unnamed attachment is shown under. The stored name stays the English text the composer
 *  minted (the `[Pasted text #N +M lines]` prompt token that restore and the summary match on is never translated);
 *  only what the card prints is localized. */
export function localizedAttachmentName(name: string): string {
  const lines = /^Pasted text · (\d+) lines$/.exec(name);
  if (lines) return t('Pasted text · {{count}} lines', { count: Number(lines[1]) });
  const numbered = /^Pasted text (\d+)$/.exec(name);
  if (numbered) return t('Pasted text {{id}}', { id: numbered[1] });
  if (name === 'Pasted text') return t('Pasted text');
  if (name === 'Pasted image') return t('Pasted image');
  if (name === 'Pasted file') return t('Pasted file');
  return name;
}
