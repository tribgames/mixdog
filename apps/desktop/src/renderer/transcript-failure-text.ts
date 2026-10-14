import { t } from './i18n';

// The session runtime writes a failed turn's reason as one fixed English
// sentence (presentErrorText / transportErrorText), optionally carrying a
// diagnostic code in parentheses. Those sentences are the translation keys;
// the code survives untranslated so the user can still report it.
// Static t() literals so the catalog extractor keeps every key.
const FIXED_REASONS: ReadonlyMap<string, () => string> = new Map([
  ['Connection to the provider was lost', () => t('Connection to the provider was lost')],
  ['Could not reach the provider', () => t('Could not reach the provider')],
  ['The provider did not respond in time', () => t('The provider did not respond in time')],
  ['Provider TLS certificate check failed', () => t('Provider TLS certificate check failed')],
  ['Provider is temporarily unavailable', () => t('Provider is temporarily unavailable')],
  ['Provider is busy at capacity', () => t('Provider is busy at capacity')],
  ['Provider authentication failed', () => t('Provider authentication failed')],
  ['Session state changed unexpectedly', () => t('Session state changed unexpectedly')],
  ['Context too large', () => t('Context too large')],
  ['Compact failed', () => t('Compact failed')],
  ['Provider is rate-limited', () => t('Provider is rate-limited')],
  ['Provider usage limit reached', () => t('Provider usage limit reached')],
  ['Not included in your plan', () => t('Not included in your plan')],
  ['Out of credits or at spend limit', () => t('Out of credits or at spend limit')],
  ['Access denied by the provider', () => t('Access denied by the provider')],
  ['Refused by the provider safety policy', () => t('Refused by the provider safety policy')],
]);

const FIXED_REASON_RE = /^(.+?)(?:\s+\(([^()]+)\))?\.?$/;

/** Localize a runtime failure reason when it is one of the fixed sentences;
 *  anything else is shown verbatim. */
export function localizedTurnFailureReason(reason: string): string {
  const text = String(reason || '').trim();
  if (!text) return '';
  const match = FIXED_REASON_RE.exec(text);
  const localize = match ? FIXED_REASONS.get(match[1]) : undefined;
  if (!match || !localize) return text;
  const sentence = localize();
  if (!match[2]) return sentence;
  const wait = /^retry in (\S+)$/.exec(match[2])?.[1];
  return wait ? t('{{sentence}} (retry in {{wait}})', { sentence, wait }) : `${sentence} (${match[2]})`;
}
