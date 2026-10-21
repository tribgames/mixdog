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

// Timeout sentences carrying a duration, the provider name and an attempt
// count (presentErrorText); each part is re-spoken through keyed copy.
const STILL_THINKING_RE = /^Model still thinking: no output in (\S+); (.+) sent nothing yet(?:; attempts: (\d+))?\.?$/;
const AGENT_WATCHDOG_RE = /^Agent watchdog stopped the run: no model response in (\S+?)\.?$/;

function localizedTimeoutReason(text: string): string | null {
  const thinking = STILL_THINKING_RE.exec(text);
  if (thinking) {
    const provider = thinking[2] === 'the provider' ? t('the provider') : thinking[2];
    return thinking[3]
      ? t('Model still thinking: no output in {{wait}}; {{provider}} sent nothing yet; attempts: {{attempts}}.', {
          wait: thinking[1],
          provider,
          attempts: thinking[3],
        })
      : t('Model still thinking: no output in {{wait}}; {{provider}} sent nothing yet.', {
          wait: thinking[1],
          provider,
        });
  }
  const watchdog = AGENT_WATCHDOG_RE.exec(text);
  if (watchdog) return t('Agent watchdog stopped the run: no model response in {{wait}}.', { wait: watchdog[1] });
  return null;
}

// The latest message that cannot fit the window (compact/runner.mjs): sizes
// inline, one cause of two, a fixed remedy. The error notice shows the first
// sentence as its summary and the rest as the next step, the transcript all of
// them, so each sentence is re-spoken on its own.
const LATEST_TURN_SENTENCES: ReadonlyArray<[RegExp, (match: RegExpExecArray) => string]> = [
  [
    /^The latest message cannot fit this model: it needs about ([\d,]+) tokens, but the ([\d,]+)-token window leaves ([\d,]+) for it\.$/,
    ([, needed, window, room]) =>
      t(
        'The latest message cannot fit this model: it needs about {{needed}} tokens, but the {{window}}-token window leaves {{room}} for it.',
        { needed, window, room }
      ),
  ],
  [
    /^The latest message cannot fit this model: it needs about ([\d,]+) tokens, but the current window leaves ([\d,]+) for it\.$/,
    ([, needed, room]) =>
      t(
        'The latest message cannot fit this model: it needs about {{needed}} tokens, but the current window leaves {{room}} for it.',
        { needed, room }
      ),
  ],
  [
    /^Its attachments alone are about ([\d,]+) tokens\.$/,
    ([, tokens]) => t('Its attachments alone are about {{tokens}} tokens.', { tokens }),
  ],
  [
    /^The latest message and protected session context \(system rules, tool definitions\) are that large\.$/,
    () => t('The latest message and protected session context (system rules, tool definitions) are that large.'),
  ],
  [
    /^Shorten the message or move large pasted text into a file the model can read\.$/,
    () => t('Shorten the message or move large pasted text into a file the model can read.'),
  ],
  [
    /^A larger context window helps only if it holds ([\d,]+) tokens plus room for the answer\.$/,
    ([, needed]) =>
      t('A larger context window helps only if it holds {{needed}} tokens plus room for the answer.', { needed }),
  ],
];

function localizedLatestTurnSentence(sentence: string): string | null {
  for (const [pattern, speak] of LATEST_TURN_SENTENCES) {
    const match = pattern.exec(sentence);
    if (match) return speak(match);
  }
  return null;
}

function localizedLatestTurnReason(text: string): string | null {
  // Sentence ends: a period before a capital (the sizes carry commas only).
  const sentences = text.split(/(?<=\.) (?=[A-Z])/);
  const localized: string[] = [];
  for (const sentence of sentences) {
    const spoken = localizedLatestTurnSentence(sentence);
    if (spoken === null) return null;
    localized.push(spoken);
  }
  return localized.join(' ');
}

/** Localize a runtime failure reason when it is one of the fixed sentences;
 *  anything else is shown verbatim. */
export function localizedTurnFailureReason(reason: string): string {
  const text = String(reason || '').trim();
  if (!text) return '';
  const timeout = localizedTimeoutReason(text);
  if (timeout) return timeout;
  const latestTurn = localizedLatestTurnReason(text);
  if (latestTurn) return latestTurn;
  const match = FIXED_REASON_RE.exec(text);
  const localize = match ? FIXED_REASONS.get(match[1]) : undefined;
  if (!match || !localize) return text;
  const sentence = localize();
  if (!match[2]) return sentence;
  const wait = /^retry in (\S+)$/.exec(match[2])?.[1];
  return wait ? t('{{sentence}} (retry in {{wait}})', { sentence, wait }) : `${sentence} (${match[2]})`;
}
