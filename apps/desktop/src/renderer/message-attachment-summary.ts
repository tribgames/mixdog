import { t } from './i18n';

const IMAGE_TOKEN = /\[Image(?: #\d+[^\]\r\n]*)?\]/g;
const FILE_TOKEN = /\[(?:PDF|File) #\d+[^\]\r\n]*\]/g;
const PASTED_TOKEN = /\[Pasted text #\d+(?: \+(\d+) lines)?\]/g;
const ANY_TOKEN = new RegExp(`${IMAGE_TOKEN.source}|${FILE_TOKEN.source}|${PASTED_TOKEN.source}`, 'g');

/** A user message's attachment tokens as one short line ("Images 1 · Files 1 ·
 *  Pasted 48 lines"), '' when it carries none. */
export function attachmentSummary(text: string): string {
  const images = (text.match(IMAGE_TOKEN) || []).length;
  const files = (text.match(FILE_TOKEN) || []).length;
  let pastedLines = 0;
  for (const match of text.matchAll(PASTED_TOKEN)) pastedLines += Number(match[1]) || 1;
  return [
    images ? t('Images {{count}}', { count: images }) : '',
    files ? t('Files {{count}}', { count: files }) : '',
    pastedLines ? t('Pasted {{count}} lines', { count: pastedLines }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The message text without its attachment tokens, for the one-line preview. */
export function textWithoutAttachmentTokens(text: string): string {
  return text
    .replace(ANY_TOKEN, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
