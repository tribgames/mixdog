// "Time format" (Settings → General / Display): a renderer-side UI preference
// for every time of day the app shows. 'system' keeps the UI language's own
// clock; '12h' / '24h' force it. Stored locally and announced to open panes.
export type TimeFormat = 'system' | '12h' | '24h';

const TIME_FORMAT_KEY = 'mixdog.desktop.time-format.v1';
const CHANGE_EVENT = 'mixdog:time-format-changed';
let fallbackFormat: TimeFormat = 'system';

const isTimeFormat = (value: unknown): value is TimeFormat => value === 'system' || value === '12h' || value === '24h';

export function getTimeFormat(): TimeFormat {
  try {
    const stored = window.localStorage.getItem(TIME_FORMAT_KEY);
    if (isTimeFormat(stored)) fallbackFormat = stored;
  } catch {
    // Desktop-local preferences degrade to the in-memory value.
  }
  return fallbackFormat;
}

export function setTimeFormat(format: TimeFormat): boolean {
  fallbackFormat = format;
  let persisted = false;
  try {
    window.localStorage.setItem(TIME_FORMAT_KEY, format);
    persisted = true;
  } catch {
    // The current renderer still applies the in-memory preference.
  }
  try {
    window.dispatchEvent(new window.Event(CHANGE_EVENT));
  } catch {
    // Non-browser imports keep the in-memory preference only.
  }
  return persisted;
}

export function subscribeTimeFormat(listener: () => void): () => void {
  const onChange = () => listener();
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

/** A clock for places that wrote a fixed `HH:mm`: unchanged for 'system', else in the chosen style. */
export function clockText(date: Date, locale: string): string {
  if (getTimeFormat() === 'system') {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...timeFormatOptions() });
}

/** Intl options to merge into a time-of-day format; read at format time. */
export function timeFormatOptions(): Pick<Intl.DateTimeFormatOptions, 'hourCycle'> {
  const format = getTimeFormat();
  if (format === '12h') return { hourCycle: 'h12' };
  if (format === '24h') return { hourCycle: 'h23' };
  return {};
}
