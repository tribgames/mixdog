import { t, uiFormatLocale, type UiLanguage } from './i18n';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { SPINNER_MODE_OVERRIDE_VERBS, SPINNER_VERBS, spinnerVerbFor } from '../../../../src/tui/spinner-verbs.mjs';

/** Pool used outside English: every entry is a catalog key in all 11 locales. */
export const LOCALIZED_ACTIVITY_VERBS: string[] = [
  'Thinking',
  'Pondering',
  'Musing',
  'Mulling',
  'Ruminating',
  'Contemplating',
  'Considering',
  'Deliberating',
  'Cogitating',
  'Inferring',
  'Ideating',
  'Envisioning',
];

/** Catalog keys for the state modes; the shared table may carry a surface-specific
 *  (Korean) string for `task-wait` that is not a key. */
const MODE_VERB_KEYS: Record<string, string> = {
  compacting: 'Compacting conversation',
  'auto-clear': 'Auto-clearing conversation',
  resuming: 'Resuming conversation',
  'task-wait': 'Waiting for tasks',
  'model-thinking': 'Model thinking',
};

const HAS_LATIN = /[A-Za-z]/;

export function activityVerbPool(language: UiLanguage = uiFormatLocale()): string[] {
  return language === 'en' ? (SPINNER_VERBS as string[]) : LOCALIZED_ACTIVITY_VERBS;
}

function localizedOrFallback(key: string, language: UiLanguage): string {
  const text = t(key);
  // An untranslated key echoes itself: outside English fall back to a localized word.
  if (language !== 'en' && text === key && HAS_LATIN.test(text)) return t('Working');
  return text;
}

// Short (not narrow) units: the narrow Japanese form is Latin (`15s`).
function waitUnit(value: number, unit: 'minute' | 'second'): string {
  return new Intl.NumberFormat(uiFormatLocale(), {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    useGrouping: false,
  }).format(value);
}

// The wait tail of an engine retry status line (`… in 210s`, `… in 3m`).
const RETRY_WAIT_TAIL = /\s+in (\d+)(ms|s|m)$/;

// The engine's reason phrases (`reason_text` in the core's retry stage); anything else is a lost connection.
const RETRY_REASONS: [RegExp, string][] = [
  [/^Rate limited by the provider\b/, 'Waiting on the provider’s request limit…'],
  [/^Provider overloaded\b/, 'Provider overloaded…'],
  [/^Provider server error\b/, 'Provider server error…'],
  [/^Provider rejected the sign-in\b/, 'Provider rejected the sign-in…'],
  [/^Safety filter refused the reply\b/, 'Safety filter refused the reply…'],
  [/^(Model still thinking|No first response)\b/, 'No response from the provider yet…'],
  [/^No progress\b/, 'Provider stopped sending data…'],
];

function waitLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return waitUnit(rest, 'second');
  return rest ? `${waitUnit(minutes, 'minute')} ${waitUnit(rest, 'second')}` : waitUnit(minutes, 'minute');
}

const retryDeadlines = new Map<string, number>();

function localRetryDeadline(key: string, retryInMs: number, now: number): number {
  for (const [other, deadline] of retryDeadlines) if (other !== key && deadline <= now) retryDeadlines.delete(other);
  const known = retryDeadlines.get(key);
  if (known !== undefined) return known;
  const deadline = now + Math.max(0, retryInMs);
  retryDeadlines.set(key, deadline);
  return deadline;
}

export interface ReconnectWait {
  /** Identifies one retry wait (the runtime's own next-attempt stamp); never compared to this clock. */
  retryKey?: string;
  /** Remaining wait when the runtime published this retry state. */
  retryInMs?: number;
  now?: number;
}

/** Whole seconds still to wait: from the locally anchored deadline when the
 *  surface knows the retry (so every repaint recomputes it), else from the
 *  text's tail as authored. 0 once the wait is over; null when neither names one. */
function remainingWaitSeconds(text: string, { retryKey = '', retryInMs, now = Date.now() }: ReconnectWait) {
  const tail = RETRY_WAIT_TAIL.exec(text);
  if (!tail) return null;
  if (retryKey && Number.isFinite(retryInMs)) {
    const left = localRetryDeadline(retryKey, Number(retryInMs), now) - now;
    return left > 0 ? Math.max(1, Math.round(left / 1_000)) : 0;
  }
  const value = Number(tail[1]);
  if (tail[2] === 'm') return value * 60;
  return tail[2] === 's' ? value : Math.ceil(value / 1_000);
}

/** The engine authors the reconnect text in English (retry countdown, quota and
 *  rate-limit notices). English shows it as-is with the wait recounted locally;
 *  other languages get the localized "Reconnecting…" plus the attempt counter
 *  and the remaining wait when the text has them. */
export function reconnectActivityVerb(
  runtimeVerb: string,
  language: UiLanguage = uiFormatLocale(),
  wait: ReconnectWait = {}
): string {
  const text = String(runtimeVerb || '').trim();
  const seconds = remainingWaitSeconds(text, wait);
  if (language === 'en') {
    if (seconds === null) return text || t('Working');
    return text.replace(RETRY_WAIT_TAIL, seconds > 0 ? ` in ${seconds}s` : '');
  }
  const attempt = /(\d+)\s*\/\s*(\d+)/.exec(text);
  const reason = RETRY_REASONS.find(([pattern]) => pattern.test(text))?.[1];
  const base = reason ? t(reason) : t('Reconnecting…');
  const counter = attempt ? `${attempt[1]}/${attempt[2]}` : /\bretry (\d+)\b/.exec(text)?.[1];
  if (!counter) return base;
  if (!seconds) return `${base} ${counter}`;
  const time = waitLabel(seconds);
  if (!reason || reason === RETRY_REASONS[0][1]) {
    const key = reason
      ? 'Waiting on the provider’s request limit… {{attempt}} · retry in {{time}}'
      : 'Reconnecting… {{attempt}} · retry in {{time}}';
    return t(key, { attempt: counter, time });
  }
  return `${base} ${counter} · ${t('retry in {{time}}', { time })}`;
}

export function activityVerb({
  mode,
  runtimeVerb = '',
  retryKey = '',
  retryInMs,
  anchor,
  now,
  language = uiFormatLocale(),
}: {
  mode: string;
  runtimeVerb?: string;
  /** Identity of a reconnect wait; '' when none. */
  retryKey?: string;
  /** That wait's remaining time at publish (runtime-relative ms). */
  retryInMs?: number;
  anchor: number;
  now: number;
  language?: UiLanguage;
}): string {
  if (mode === 'stopping') return localizedOrFallback('Stopping…', language);
  if (SPINNER_MODE_OVERRIDE_VERBS[mode]) {
    const key = MODE_VERB_KEYS[mode] || String(SPINNER_MODE_OVERRIDE_VERBS[mode]);
    return localizedOrFallback(key, language);
  }
  if (mode === 'reconnecting') return reconnectActivityVerb(runtimeVerb, language, { retryKey, retryInMs, now });
  return localizedOrFallback(String(spinnerVerbFor(anchor, now, activityVerbPool(language))), language);
}

/** The "thinking" part of the byline. The effort word is the model chip's own
 *  name ("High"), kept spelled like the chip; the surrounding words localize. */
export function thinkingEffortLabel(effortWord: string, language: UiLanguage = uiFormatLocale()): string {
  if (effortWord) return t('Thinking ({{effort}})', { effort: effortWord });
  return t('Thinking (spinner)', { defaultValue: language === 'en' ? 'Thinking' : t('Thinking') });
}
