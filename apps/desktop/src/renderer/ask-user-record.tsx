import { loginSiteLabel } from '../shared/login-site';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { asRecord } from './text-format';
import { desktopToolDisplayIdentity } from './transcript-tool-core';
import { askUserAnswers, askUserChatReply, toolActivityResultValue } from './transcript-tool-result';

/** The ask_user arguments of a call, direct or through the call_tool bridge; null for any other call. */
function askUserArgs(item: TranscriptItem): Record<string, unknown> | null {
  if (item.kind !== 'tool') return null;
  const identity = desktopToolDisplayIdentity(item.name, item.args);
  return identity.name === 'ask_user' ? (asRecord(identity.args) ?? {}) : null;
}

/** An ask_user call that has its result: it renders as a card, not a tool row. */
export function isAnsweredAskUser(item: TranscriptItem): boolean {
  return askUserArgs(item) !== null && typeof toolActivityResultValue(item) === 'string';
}

const isWaitingAskUser = (item: TranscriptItem): boolean => askUserArgs(item) !== null && !isAnsweredAskUser(item);

/** Whether a transcript item (or a roll-up member) is a question still waiting
 *  for its answer: its row stays mounted so the live card keeps its state. */
export function holdsWaitingAskUser(item: TranscriptItem): boolean {
  const members =
    item.aggregate === true && Array.isArray(item.toolMembers) ? (item.toolMembers as TranscriptItem[]) : [item];
  return members.some(isWaitingAskUser);
}

/** A tool row's items with its questions taken out (also from inside a
 *  roll-up): answered ones render as summaries after what is left, and a
 *  waiting one as the live card when `hasCard`. */
export function splitAskUser(
  items: readonly TranscriptItem[],
  hasCard: boolean
): { rest: TranscriptItem[]; asked: TranscriptItem[]; waiting: boolean } {
  const rest: TranscriptItem[] = [];
  const asked: TranscriptItem[] = [];
  let waiting = false;
  const taken = (item: TranscriptItem) => isAnsweredAskUser(item) || (hasCard && isWaitingAskUser(item));
  for (const item of items) {
    const members =
      item.aggregate === true && Array.isArray(item.toolMembers) ? (item.toolMembers as TranscriptItem[]) : [item];
    const out = members.filter(taken);
    if (!out.length) {
      rest.push(item);
      continue;
    }
    const answered = out.filter(isAnsweredAskUser);
    asked.push(...answered);
    if (answered.length < out.length) waiting = true;
    const left = members.filter((member) => !out.includes(member));
    if (!left.length) continue;
    // Only answered questions were counted as completed.
    const less = (value: unknown, by: number) => Math.max(0, Number(value ?? 0) - by);
    rest.push({
      ...item,
      toolMembers: left,
      count: less(item.count ?? members.length, out.length),
      completedCount: less(item.completedCount, answered.length),
    });
  }
  return { rest, asked, waiting };
}

/** The picked labels, which the runtime joined with ", ": matched against the
 *  options longest first, so a label that itself holds ", " stays whole.
 *  Anything left unmatched is kept as its own chip rather than dropped. */
function pickedLabels(value: string, labels: string[]): string[] {
  const byLength = [...labels].sort((a, b) => b.length - a.length);
  const picked: string[] = [];
  let rest = value;
  while (rest) {
    const label = byLength.find((l) => !picked.includes(l) && (rest === l || rest.startsWith(`${l}, `)));
    if (!label) return [...picked, rest];
    picked.push(label);
    rest = rest.slice(label.length + 2);
  }
  return picked;
}

function closedNote(result: string): string {
  if (result.startsWith('User has answered your questions: ') || askUserChatReply(result).reply) return '';
  // Questions no longer expire, but transcripts from before still carry it.
  if (result.startsWith('User did not answer in time.')) return t('Question timed out · the agent decided');
  if (result.startsWith('No user is available')) return t('No one to answer · the agent decided');
  return t('Question closed · the agent decided');
}

/** A finished login takeover: "로그인됨 · <site>" (or not signed in), one head line. */
function LoginRecord({ url, done }: { url: string; done: boolean }) {
  const site = loginSiteLabel(url);
  const title = done ? t('Signed in') : t('Not signed in');
  return (
    <article className="question-card" data-settled data-approval="login" aria-label={title}>
      <div className="question-head">
        <span className="question-icon" data-tone={done ? 'done' : undefined} aria-hidden="true">
          {done ? '✓' : '?'}
        </span>
        <span className="question-title">
          <strong>{title}</strong>
          {site && <span className="question-meta">{site}</span>}
        </span>
      </div>
    </article>
  );
}

/** An answered ask_user call, kept in the transcript as the card it was, picks marked. */
export function AskUserRecord({ item }: { item: TranscriptItem }) {
  const result = String(toolActivityResultValue(item) ?? '');
  const args = askUserArgs(item);
  const handoff = asRecord(args?.handoff);
  if (handoff?.purpose === 'login') return <LoginRecord url={String(handoff.url ?? '')} done={result === 'done'} />;
  const questions = (Array.isArray(args?.questions) ? (args.questions as unknown[]) : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const { reply } = askUserChatReply(result);
  const note = closedNote(result);
  const parsed = askUserAnswers(result);
  const rows = questions.map((question) => {
    const text = String(question.question ?? '');
    const labels = (Array.isArray(question.options) ? question.options : [])
      .map((option) => String(asRecord(option)?.label ?? ''))
      .filter(Boolean);
    const answer = parsed.get(text);
    const answers = answer ? [...pickedLabels(answer.picked, labels), ...(answer.typed ? [answer.typed] : [])] : [];
    return { text, answers };
  });
  const single = rows.length === 1;
  const title = single
    ? rows[0].text
    : note
      ? t('Agent question')
      : t('{{count}} questions answered', { count: rows.length });
  // A chat reply stands for the unpicked questions: only picks are listed.
  const shown = reply ? rows.filter((row) => row.answers.length > 0) : rows;
  return (
    <section className="ask-user-record" aria-label={t('Agent question')}>
      <div className="question-head">
        <span className="question-icon" data-tone={note ? undefined : 'done'} aria-hidden="true">
          {note ? '?' : '✓'}
        </span>
        <span className="question-title">
          <strong className="ask-user-record-title">{title}</strong>
        </span>
      </div>
      {shown.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: questions are positional and never reorder
        <div className="ask-user-record-question" key={index}>
          {!single && <span className="ask-user-record-q">{row.text}</span>}
          <span className="ask-user-record-answers">
            {row.answers.length ? (
              row.answers.map((answer, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a typed answer may repeat a label
                <span className="ask-user-record-chip" key={at}>
                  {answer}
                </span>
              ))
            ) : (
              <span className="ask-user-record-none">{t('No answer')}</span>
            )}
          </span>
        </div>
      ))}
      {reply && (
        <div className="ask-user-record-question" data-reply>
          <span className="ask-user-record-q">{t('Sent message')}</span>
          <span className="ask-user-record-answers">
            <span className="ask-user-record-typed">{reply}</span>
            <small className="ask-user-record-via">{t('Answered in chat')}</small>
          </span>
        </div>
      )}
      {note && <div className="ask-user-record-note">{note}</div>}
    </section>
  );
}
