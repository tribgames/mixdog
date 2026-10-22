import { t, uiFormatLocale } from '../i18n';
import { timeFormatOptions } from '../time-format-preference';

/** "Just now", "Today 1:00 PM", "Yesterday", else "Oct 9" — the same shape as
 *  the phone app's PC list. */
export function relativeWhen(at: number, now = Date.now()): string {
  const locale = uiFormatLocale();
  const date = new Date(at);
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  if (now - at < 60_000) return t('Just now');
  const diff = Math.round((day(new Date(now)) - day(date)) / 86_400_000);
  if (diff <= 0) {
    const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', ...timeFormatOptions() });
    return t('Today {{time}}', { time });
  }
  if (diff === 1) return t('Yesterday');
  return date.toLocaleDateString(locale, { month: 'long', day: 'numeric' });
}
