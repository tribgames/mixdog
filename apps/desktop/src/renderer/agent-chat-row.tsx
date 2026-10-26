// One transcript row in agent mode (agent-chat-mode.ts): the same row node
// coding mode paints, framed as a messenger line — an agent's run of bubbles
// on the left under one face and name, the user's on the right, the time at
// the run's last bubble, a date pill where the day changes. Tool rounds and
// notices stay compact rows in the bubble column.
import { Link2, Timer } from 'lucide-react';
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AgentHandoffBlock } from './agent-task-line';
import type { RoomMemberLabel } from './agent-room-parts';
import { RoomMemberFace } from './agent-room-parts';
import type { AvatarMotionState } from './avatar-motion';
import { type AgentChatPlace, chatRoutineOf, chatRoutineTriggerOf } from './agent-chat-place';
import { stripRoutineTriggerHeader } from '../../../../src/runtime/shared/routine-trigger.mjs';
import { OPEN_AGENT_PANEL_EVENT, setAgentPanelTab } from './agent-panel-tab';
import { OPEN_TASK_SESSION_EVENT } from './agent-task-events';
import type { TranscriptItem } from './desktop-types';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { t, uiFormatLocale } from './i18n';
import { timeFormatOptions } from './time-format-preference';
import MarkdownBody from './MarkdownBody';
import { CopyControl } from './transcript-primitives';
import { oneLine } from './text-format';
import { ChromeReimportButton, routineLoginRequiredSite, signInAgainOn } from './browser-login-recovery';
import { routineFailureLine, routineHumanNeededLine } from './routine-notice';
import './agent-chat.css';

const timeText = (at: number) =>
  at ? new Date(at).toLocaleTimeString(uiFormatLocale(), { timeStyle: 'short', ...timeFormatOptions() }) : '';
const dayText = (at: number) => new Date(at).toLocaleDateString(uiFormatLocale(), { dateStyle: 'full' });

/** Show `sessionId`'s 루틴 tab, where each routine's runs are listed. */
function openRoutines(sessionId: string) {
  if (!sessionId) return;
  setAgentPanelTab('routines');
  window.dispatchEvent(new CustomEvent(OPEN_AGENT_PANEL_EVENT, { detail: { sessionId } }));
}

function RoutineGlyph({ kind }: { kind: 'schedule' | 'webhook' }) {
  const Icon = kind === 'webhook' ? Link2 : Timer;
  return <Icon size={12} aria-hidden="true" />;
}

type RoutineStatus = 'running' | 'ok' | 'failed' | 'login' | 'delivery';

function routineStatus(item: TranscriptItem): { status: RoutineStatus; site: string | null } {
  const routine = chatRoutineOf(item);
  // An expired sign-in: the way back instead of a plain retry.
  const site = routine?.failed ? routineLoginRequiredSite(routine.summary) : null;
  if (routine?.running) return { status: 'running', site };
  if (routine?.deliveryFailed) return { status: 'delivery', site };
  if (site) return { status: 'login', site };
  return { status: routine?.failed ? 'failed' : 'ok', site };
}

const STATUS_LABEL: Record<RoutineStatus, () => string> = {
  running: () => t('Running'),
  ok: () => t('Succeeded'),
  failed: () => t('Failed'),
  login: () => t('Sign-in required'),
  delivery: () => t('Delivery failed'),
};

// A live routine row (running, undelivered, a result posted while the thread
// is open) carries no time of its own until the thread is reloaded: the time
// it first reached this window stands in, kept per run so a row the result
// replaces keeps it.
const liveRunAt = new Map<string, number>();
function routineAt(item: TranscriptItem): number {
  if (typeof item.at === 'number' && item.at > 0) return item.at;
  const runId = String((item.routine as { runId?: unknown } | undefined)?.runId ?? '');
  if (!runId) return 0;
  if (!liveRunAt.has(runId)) liveRunAt.set(runId, Date.now());
  return liveRunAt.get(runId) ?? 0;
}

/** The run's own session (its 실행 기록), else the 루틴 tab. */
function openRunHistory(runSessionId: string, sessionId: string) {
  if (runSessionId)
    window.dispatchEvent(new CustomEvent(OPEN_TASK_SESSION_EVENT, { detail: { sessionId: runSessionId } }));
  else openRoutines(sessionId);
}

/** A run's summary: markdown, clamped to three lines with "더 보기" while it
 *  overflows; the clamped view drops inline code's chip styling. */
function RoutineSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new summary text is re-measured
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && !open) setClamped(node.scrollHeight > node.clientHeight + 1);
  }, [open, text]);
  if (!text) return null;
  return (
    <div className="mx-routine-body">
      <div ref={ref} className="mx-routine-summary" data-open={open || undefined}>
        <MarkdownBody text={text} copyControl={CopyControl} />
      </div>
      {(clamped || open) && (
        <button type="button" className="mx-routine-more" onClick={() => setOpen(!open)}>
          {open ? t('Show less') : t('Show more')}
        </button>
      )}
    </div>
  );
}

/** A failed run: its short localized reason as the headline, the raw message
 *  only behind "Details". */
function RoutineFailure({ routine }: { routine: { summary: string; reason: string; paused: boolean } }) {
  const [open, setOpen] = useState(false);
  const raw = routine.summary.trim();
  return (
    <div className="mx-routine-body">
      <div>{routineFailureLine(raw, routine.reason, routine.paused)}</div>
      {raw && !routineHumanNeededLine(raw) && (
        <>
          <button type="button" className="mx-routine-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {t('Details')}
          </button>
          {open && <RoutineSummary text={raw} />}
        </>
      )}
    </div>
  );
}

/** One routine's consecutive results as one card in the bubble column (the
 *  question card's grammar): the head names the routine and opens the 루틴
 *  tab; the latest run is expanded with its status, time and summary, older
 *  runs fold to one line each that opens in place; the foot carries what the
 *  latest run needs (run again, sign in again) and the run history. */
export function AgentRoutineCard({ runs, sessionId }: { runs: readonly TranscriptItem[]; sessionId: string }) {
  const [opened, setOpened] = useState<number | null>(null);
  const latest = runs.at(-1);
  const routine = latest ? chatRoutineOf(latest) : null;
  if (!latest || !routine) return null;
  const { status, site } = routineStatus(latest);
  const runAgain = () =>
    void Promise.resolve(
      window.mixdogDesktop?.invokeCapability?.({
        capability: routine.kind === 'webhook' ? 'runWebhookNow' : 'runScheduleNow',
        args: [routine.name],
      } as Parameters<NonNullable<typeof window.mixdogDesktop>['invokeCapability']>[0])
    ).catch((error: unknown) => showDesktopToast(errorMessageText(error), 'error'));
  // Re-sends the finished run's result without running it again.
  const retryDelivery = () =>
    void Promise.resolve(
      window.mixdogDesktop?.invokeCapability?.({
        capability: 'retryRoutineDelivery',
        args: [routine.kind, routine.name],
      } as Parameters<NonNullable<typeof window.mixdogDesktop>['invokeCapability']>[0])
    ).catch((error: unknown) => showDesktopToast(errorMessageText(error), 'error'));
  const chip = (state: RoutineStatus) => (
    <span className="mx-routine-chip" data-status={state}>
      {STATUS_LABEL[state]()}
    </span>
  );
  const at = (item: TranscriptItem) => timeText(routineAt(item));
  const summaryOf = (item: TranscriptItem) => (chatRoutineOf(item)?.summary || '').trim();
  const latestSummary = summaryOf(latest);
  const renderBody = () => {
    if (status === 'running') {
      return (
        <div className="mx-routine-body" role="status" aria-label={t('Running…')}>
          <span className="mx-routine-running">{t('Running…')}</span>
          <span className="mx-chat-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      );
    }
    if (status === 'delivery') {
      return (
        <div className="mx-routine-body mx-routine-note">
          {t('Delivery failed')}
          <span aria-hidden="true"> · </span>
          <button type="button" className="mx-routine-more" onClick={retryDelivery}>
            {t('Retry')}
          </button>
        </div>
      );
    }
    if (status === 'failed' || status === 'login') return <RoutineFailure routine={routine} />;
    if (latestSummary) return <RoutineSummary text={latestSummary} />;
    return <div className="mx-routine-body mx-routine-note">{t('Nothing to report')}</div>;
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <article> keeps its tag; role="group" names the card
    <article
      className="question-card mx-routine-card"
      role="group"
      aria-label={routine.name}
      data-agent-mode="true"
      data-status={status}
    >
      <button type="button" className="question-head mx-routine-head" onClick={() => openRoutines(sessionId)}>
        <span className="question-icon mx-routine-icon" aria-hidden="true">
          <RoutineGlyph kind={routine.kind} />
        </span>
        <span className="question-title">
          <strong>{routine.name}</strong>
        </span>
        {chip(status)}
        <time className="mx-routine-time">{at(latest)}</time>
      </button>
      {runs.length > 1 && (
        <ul className="mx-routine-older" aria-label={t('Earlier runs')}>
          {runs.slice(0, -1).map((run, index) => {
            const own = routineStatus(run).status;
            const open = opened === index;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and append-only
              <li key={index}>
                <button type="button" aria-expanded={open} onClick={() => setOpened(open ? null : index)}>
                  <span>{at(run)}</span>
                  <span aria-hidden="true">·</span>
                  <span data-status={own}>{STATUS_LABEL[own]()}</span>
                </button>
                {open &&
                  (own === 'failed' || own === 'login' ? (
                    <RoutineFailure routine={chatRoutineOf(run) ?? routine} />
                  ) : (
                    <RoutineSummary text={summaryOf(run)} />
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {renderBody()}
      <div className="question-foot mx-routine-foot" hidden={status === 'running' || undefined}>
        {status === 'failed' && (
          <button type="button" className="mx-routine-action" onClick={runAgain}>
            {t('Run again')}
          </button>
        )}
        {status === 'login' && site && sessionId && (
          <>
            <button type="button" className="mx-routine-action" onClick={() => signInAgainOn(site, sessionId)}>
              {t('Sign in again')}
            </button>
            <ChromeReimportButton sessionId={sessionId} className="mx-routine-action" />
          </>
        )}
        <button
          type="button"
          className="mx-routine-action"
          data-quiet="true"
          onClick={() => openRunHistory(routine.runSessionId, sessionId)}
        >
          {t('Run history')}
        </button>
      </div>
    </article>
  );
}

/** A routine fire delivered as a turn: one compact marker row — the
 *  routine's glyph and name (a webhook's event after it), its time, and its
 *  instructions behind a disclosure — where a user bubble would be. The bot's
 *  reply below it is the run's result. */
export function AgentRoutineTrigger({ item, sessionId }: { item: TranscriptItem; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const trigger = chatRoutineTriggerOf(item);
  if (!trigger) return null;
  const instructions = stripRoutineTriggerHeader(item.text).trim();
  const at = typeof item.at === 'number' ? timeText(item.at) : '';
  return (
    <div className="mx-routine-trigger" data-kind={trigger.kind}>
      <div className="mx-routine-trigger-head">
        <button
          type="button"
          className="mx-routine-trigger-name"
          aria-label={trigger.name}
          onClick={() => openRoutines(sessionId)}
        >
          <span className="mx-routine-icon" aria-hidden="true">
            <RoutineGlyph kind={trigger.kind} />
          </span>
          <strong>{trigger.name}</strong>
          {trigger.event && <span className="mx-routine-trigger-event">{trigger.event}</span>}
        </button>
        {at && <time className="mx-routine-time">{at}</time>}
        {instructions && (
          <button type="button" className="mx-routine-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t('Show less') : t('Show more')}
          </button>
        )}
      </div>
      {open && (
        // Plain text: a webhook's fenced payload is data, never rendered markup.
        <div className="mx-routine-trigger-body">{instructions}</div>
      )}
    </div>
  );
}

/** The separate "Open ↗" action: opens `sessionId`. */
function OpenSessionButton({ sessionId }: { sessionId: string }) {
  if (!sessionId) return null;
  return (
    <button
      type="button"
      className="mx-routine-more mx-open-session"
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_TASK_SESSION_EVENT, { detail: { sessionId } }))}
    >
      {t('Open ↗')}
    </button>
  );
}

/** Another bot's words in this chat (its message, or its answer to this chat's
 *  send): one folded line with the start of the text, the words behind a
 *  disclosure as a quote, and for an answer a link to the whole reply in the
 *  answering session (the summary is cut). */
export function AgentBotFolded({ text, sessionId }: { text: string; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const preview = oneLine(text.replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '').replace(/\*\*|__|`/g, ''), 200);
  return (
    <div className="mx-bot-fold">
      <div className="mx-bot-fold-pill">
        <span className="mx-bot-fold-preview">{preview}</span>
        <button type="button" className="mx-routine-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('Show less') : t('View message')}
        </button>
        {sessionId && <OpenSessionButton sessionId={sessionId} />}
      </div>
      {open && (
        <article className="message assistant settled mx-bot-fold-body">
          <div className="message-body">
            <MarkdownBody text={text} copyControl={CopyControl} />
          </div>
        </article>
      )}
    </div>
  );
}

/** An old routine result row without its marker: the agent's own bubble. */
export function AgentRoutineBody({ item }: { item: TranscriptItem }) {
  const text = String(item.text || '').trim();
  return (
    <article className="message assistant settled">
      <div className="message-body">
        <MarkdownBody text={text} copyControl={CopyControl} />
      </div>
    </article>
  );
}

/** The live band in agent mode: `member`'s typing bubble. */
export function AgentTypingRow({
  member,
  lead,
  after,
}: {
  member: RoomMemberLabel;
  /** The bubble opens a run: face, name and tail. */
  lead: boolean;
  /** Under the bubble, in its column (the turn's hand-off lines). */
  after?: ReactNode;
}) {
  return (
    <AgentChatRow
      place={{ side: 'agent', speaker: member.id, first: lead, last: false, at: 0, newDay: false }}
      member={member}
      faceState="typing"
      after={after}
    >
      <div
        className="message assistant mx-chat-typing"
        role="status"
        aria-label={t('{{name}} is typing…', { name: member.name })}
      >
        <div className="message-body">
          <span className="mx-chat-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </AgentChatRow>
  );
}

export function AgentChatRow({
  place,
  member,
  card = false,
  faceState,
  after,
  children,
}: {
  /** Under the bubble, in its column (the turn's hand-off lines). */
  after?: ReactNode;
  /** null: a tool round or the live band, outside any run. */
  place: AgentChatPlace | null;
  /** The speaking agent (agent bubbles only). */
  member: RoomMemberLabel | null;
  /** A routine card: it carries its own time. */
  card?: boolean;
  /** The face's motion (the typing bubble's head-bob). */
  faceState?: AvatarMotionState;
  children?: ReactNode;
}) {
  if (place?.side === 'hidden') return null;
  const side = place?.side ?? 'aside';
  const lead = side === 'agent' && place?.first && member;
  const time = !card && place?.last && (side === 'agent' || side === 'user') ? timeText(place.at) : '';
  // The hand-off block takes the time onto its first line.
  const sharesTime = Boolean(time) && isValidElement(after) && after.type === AgentHandoffBlock;
  const timedAfter = sharesTime ? cloneElement(after as ReactElement<{ time?: string }>, { time }) : null;
  return (
    <>
      {place?.newDay && (
        <div className="mx-chat-day">
          <span>{dayText(place.at)}</span>
        </div>
      )}
      <div
        className="mx-chat-row"
        data-side={side}
        data-first={place?.first ? 'true' : undefined}
        data-last={place?.last ? 'true' : undefined}
        data-card={card ? 'routine' : undefined}
      >
        {lead && <RoomMemberFace member={member} className="mx-chat-face" state={faceState} />}
        <div className="mx-chat-column">
          {lead && (
            <div className="mx-chat-name">
              {member.name}
              {place?.bot && <span className="mx-chat-bot-tag">{t('Bot message')}</span>}
            </div>
          )}
          <div className="mx-chat-line">{children}</div>
          {timedAfter ?? (time && <time className="mx-chat-time">{time}</time>)}
          {sharesTime ? null : after}
        </div>
      </div>
    </>
  );
}
