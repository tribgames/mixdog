/**
 * Subscription usage answers, kept per host so the usage dialog paints at
 * once: an opening shows the last answer to its question while that question
 * is read again, and the usage flyout reads ahead what a click on it opens.
 * Everyone asking one question shares its read.
 */
import { readGlobalCapabilities } from './global-capability-reads';
import { record } from './record-utils';
import { peekQuotaFocus, readQuotaSubscription, type QuotaFocus } from './usage-surface-mode';

type Row = Record<string, unknown>;
export type QuotaApi = NonNullable<Parameters<typeof readGlobalCapabilities>[0]>;

const ANSWER_LIMIT = 24;
// A read-ahead skips a question answered this recently; opening reads it again anyway.
const READ_AHEAD_FRESH_MS = 30_000;

type QuotaCache = {
  answers: Map<string, { answer: Row; at: number }>;
  reads: Map<string, Promise<Row>>;
};
const caches = new WeakMap<QuotaApi, QuotaCache>();

function cacheOf(api: QuotaApi): QuotaCache {
  let cache = caches.get(api);
  if (!cache) {
    cache = { answers: new Map(), reads: new Map() };
    caches.set(api, cache);
  }
  return cache;
}

const keyOf = (question: Row) => JSON.stringify(question);

/** Keep `answer` for `question`; the least recently kept go past the limit. */
export function rememberQuotaAnswer(api: QuotaApi, question: Row, answer: Row): void {
  const { answers } = cacheOf(api);
  const key = keyOf(question);
  answers.delete(key);
  answers.set(key, { answer, at: Date.now() });
  while (answers.size > ANSWER_LIMIT) answers.delete(answers.keys().next().value as string);
}

export function cachedQuotaAnswer(api: QuotaApi, question: Row): Row | undefined {
  return cacheOf(api).answers.get(keyOf(question))?.answer;
}

/** Ask the ledger, joining a read of the same question already under way. */
export function readQuotaAnswer(api: QuotaApi, question: Row): Promise<Row> {
  const { reads } = cacheOf(api);
  const key = keyOf(question);
  let read = reads.get(key);
  if (!read) {
    read = readGlobalCapabilities(api, [{ capability: 'getQuotaHistory', args: [question] }])
      .then(([value]) => {
        const answer = record(value);
        rememberQuotaAnswer(api, question, answer);
        return answer;
      })
      .finally(() => reads.delete(key));
    reads.set(key, read);
  }
  return read;
}

/** What subscription usage opens on: the meter that asked, else the
 *  subscription and window shown last, else the one in use — always on the
 *  account in use, which an account switch may have changed since. */
export function openingQuotaQuestion(focus: QuotaFocus | null = peekQuotaFocus()) {
  const last = focus ? null : readQuotaSubscription();
  return {
    provider: focus?.provider || last?.provider || '',
    account: focus?.account || '',
    window: focus?.window || last?.window || '',
    view: 'window' as const,
  };
}

/** A page of a limit window's history, asked alike by the dialog and the read-ahead. */
export function quotaHistoryQuestion(provider: string, account: string, window: string, page = 0) {
  return { provider, account, window, page };
}

/** A recent enough answer as it is, else a read (joining one under way). */
function readAhead(api: QuotaApi, question: Row): Promise<Row> {
  const known = cacheOf(api).answers.get(keyOf(question));
  if (known && Date.now() - known.at < READ_AHEAD_FRESH_MS) return Promise.resolve(known.answer);
  return readQuotaAnswer(api, question);
}

/** Read ahead what opening subscription usage will show — `focus` for a
 *  meter's own — and the newest page of that window's history below it. */
export function prefetchQuotaUsage(api: QuotaApi, focus: QuotaFocus | null = null): void {
  void readAhead(api, openingQuotaQuestion(focus))
    .then((answer) => {
      const shown = record(answer.selection);
      if (!shown.provider) return undefined;
      return readAhead(
        api,
        quotaHistoryQuestion(String(shown.provider), String(shown.account || ''), String(shown.label || ''))
      );
    })
    .catch(() => undefined);
}
