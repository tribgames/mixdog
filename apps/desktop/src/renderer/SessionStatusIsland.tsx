import { Activity } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { liveAgentRows, liveShellCount, liveShellRows } from './AgentActivityPane';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { MxIcon } from './MxIcon';
import { showDesktopToast } from './notifications';
import { touchPrimaryPointer } from './surface-input-focus';
import { ContextUsageIndicator, formatWorkElapsed } from './TranscriptView';

/** The readout ticks its own 1s clock only while its session has live work,
 *  so an idle island costs no timers. */
function useActivityClock(active: boolean): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return clock;
}

// A background shell's argv is not a label: `pwsh -NoProfile -Command "npm run
// build --prefix apps/desktop"` filled the card with flags, quotes and paths,
// so the ellipsis left fragments like `--prefix` behind (user: 쉘 돌 때 문장이
// --뭐 이런 걸로 깨져나옴). The row keeps the runnable SUBJECT — wrapper shell
// dropped, flags cut, paths reduced to their file name — and the Agents dock
// keeps the full command.
const SHELL_WRAPPER = /^(?:pwsh|powershell|cmd|bash|sh|zsh|env|npx)(?:\.exe)?$/i;
const SHELL_SUBJECT_WORDS = 4;

function shellCommandLabel(command: string): string {
  const source = command.replace(/\s+/g, ' ').trim();
  if (!source) return '';
  let tokens = source.split(' ');
  // A wrapper shell hides the real command behind its own switches.
  while (tokens.length > 1 && SHELL_WRAPPER.test(tokens[0].replace(/^.*[\\/]/, ''))) {
    const rest = tokens.slice(1);
    const subject = rest.findIndex((token) => !/^[-/]/.test(token));
    if (subject < 0) break;
    tokens = rest.slice(subject);
  }
  const words: string[] = [];
  for (const token of tokens) {
    const word = token.replace(/^["']+|["']+$/g, '');
    if (!word) continue;
    if (word.startsWith('-')) break;
    words.push(word.replace(/^.*[\\/]/, '') || word);
    if (words.length >= SHELL_SUBJECT_WORDS) break;
  }
  return words.join(' ') || source;
}

// ONE aggregate work readout (user: 쉘하고 에이전트는 합쳐서 작업 현황으로):
// agents and background shells share a single slot left of the context gauge,
// and the hover popover keeps the per-task breakdown. Separate Agent and
// Shell chips grew the island to three slots for one turn's work.
export function LiveWorkIndicator({ snapshot }: {
  snapshot: Snapshot;
}) {
  const agents = liveAgentRows(snapshot);
  // A tool call publishes its count before the worker row lands; the larger
  // of the two is the honest number.
  const agentCount = Math.max(agents.length,
    Math.max(0, Number(snapshot.activeTools?.agent?.count) || 0));
  const shells = liveShellRows(snapshot);
  // Every command still running surfaces here — foreground and background
  // alike (user: 실제 호출할때 나오고 종료될때 사라지게). The runtime publishes
  // a live record for both and retires it the moment the command settles.
  const shellCount = Math.max(liveShellCount(snapshot), shells.length);
  const total = agentCount + shellCount;
  const clock = useActivityClock(total > 0);
  const elapsed = (startedAt: number) => startedAt
    ? formatWorkElapsed(clock - startedAt) || '0s'
    : '';
  // Every row carries BOTH cells, empty ones included: the card lays its
  // label/value pair out on one shared grid, so a missing value cell would
  // slide the next row's label into the value column.
  const rows: {
    key: string;
    label: string;
    detail: string;
    /** What a Stop press ends: an agent's running turn, or one background
     *  shell task. An aggregate count row addresses nothing and gets no
     *  button — there is no single job behind it to cancel. */
    stop?: { kind: 'agent' | 'shell'; id: string };
  }[] = [];
  for (const agent of agents) {
    rows.push({
      key: agent.key,
      label: agent.role,
      detail: agent.queued
        ? t('Queued')
        : elapsed(agent.turnStartedAt || agent.startedAt) || agent.status,
      ...(agent.tag ? { stop: { kind: 'agent' as const, id: agent.tag } } : {}),
    });
  }
  if (agentCount > agents.length) {
    rows.push({
      key: 'agent-tools',
      label: `${t('Agent')} ${agentCount - agents.length}`,
      detail: elapsed(Number(snapshot.activeTools?.agent?.startedAt) || 0),
    });
  }
  for (const shell of shells) {
    rows.push({
      key: shell.key,
      label: shellCommandLabel(shell.command) || t('Shell'),
      detail: elapsed(shell.startedAt),
      // The row already carries the job's own task id, so Stop ends THAT
      // background command and leaves the turn itself running.
      stop: { kind: 'shell', id: shell.key },
    });
  }
  if (shellCount > shells.length) {
    rows.push({
      key: 'shell-jobs',
      label: `${t('Shell')} ${shellCount - shells.length}`,
      detail: String(snapshot.shellJobs?.elapsedLabel || ''),
    });
  }
  // A coarse pointer has no hover to read the card with, so there a tap opens
  // the same card the desktop shows on hover, and the next pointer landing
  // outside it — or Escape — puts it away again.
  const touch = touchPrimaryPointer();
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && host.current?.contains(target)) return;
      setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
    };
  }, [open]);
  // ABB: the tapped-open activity card closes on hardware back.
  useMobileBack(open, () => setOpen(false));
  // Stop rides the OWNER session: this card paints one Lead's lane, so an
  // agent cancel and a background-shell cancel both resolve inside that
  // session's own scope rather than whichever pane holds focus.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const ownerSessionId = String(snapshot.sessionId || '').trim();
  const stop = async (target: { kind: 'agent' | 'shell'; id: string }) => {
    const key = `${target.kind}:${target.id}`;
    if (!target.id || stopping.has(key)) return;
    setStopping((current) => new Set(current).add(key));
    try {
      const request = target.kind === 'agent'
        ? { capability: 'agentControl' as const, args: [{ type: 'cancel', tag: target.id }] }
        : { capability: 'taskControl' as const, args: [{ action: 'cancel', task_id: target.id }] };
      await window.mixdogDesktop.invokeCapability({
        ...request,
        ...(ownerSessionId ? { sessionId: ownerSessionId } : {}),
      });
    } catch (reason) {
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  const actionable = rows.some((row) => row.stop);
  return <div className="session-work-indicator" ref={host}
    data-active={total > 0 ? 'true' : 'false'}
    data-open={open ? 'true' : 'false'}>
    {/* No count badge (user: 카운트로 바뀌지 말고 애니만): the slot keeps ONE
        fixed-width icon and live work reads as a quiet pulse on the glyph, so
        nothing in the capsule resizes mid-turn. The exact tally stays in the
        popover and in the accessible label. */}
    {/* The button carries no action any more (user: 클릭 시 나오는 팝업/화면
        전환은 필요없음): it stays a button so keyboard focus can still summon
        the card and a touch tap has something to hit. */}
    <button type="button"
      onClick={() => { if (touch) setOpen((value) => !value); }}
      aria-label={t('Background activity: {{count}} running', { count: total })}>
      <Activity className="session-work-icon" size={18} aria-hidden="true" />
    </button>
    {/* The card is ALWAYS mounted (user: 그냥 아예 안 나왔거든): an idle hover
        used to answer with nothing at all, so the slot read as dead chrome. */}
    <div className="live-work-popover" role="tooltip"
      data-actions={actionable ? 'true' : undefined}>
      {rows.length
        ? rows.map((row) => <div className="live-work-row" key={row.key}
          /* Shell work animates; agents keep the static label. Both the
             per-job rows (which carry a shell stop target) and the aggregate
             count row qualify. */
          data-flow={row.stop?.kind === 'shell' || row.key === 'shell-jobs' ? 'true' : undefined}>
          <span>{row.label}</span>
          <small>{row.detail}</small>
          {actionable && (row.stop
            ? <button type="button" className="live-work-stop"
                disabled={stopping.has(`${row.stop.kind}:${row.stop.id}`)}
                aria-label={t('Stop')} title={t('Stop')}
                onClick={() => { void stop(row.stop as { kind: 'agent' | 'shell'; id: string }); }}>
              {/* Same stop square the composer uses to end a turn (user: X
                  보단 우리 채팅 중단 버튼처럼), so one glyph means "end this"
                  everywhere in the app. */}
              <MxIcon name="stop" size={10} />
            </button>
            : <i aria-hidden="true" />)}
        </div>)
        : <div className="live-work-row" key="idle">
          <span>{t('No background work')}</span>
          <small />
        </div>}
    </div>
  </div>;
}

// ONE translucent capsule pinned to the transcript's top-right corner (user:
// 아이폰 다이나믹 아일랜드 같은 섬). Both readouts used to live elsewhere —
// the gauge inside the composer footer, the Agent/Shell chips floating right
// above the composer — where they competed with the input surface for space
// (user: 채팅 입력을 가린다). The capsule frames exactly TWO slots: aggregate
// work status, then the context gauge.
export function SessionStatusIsland({ snapshot }: {
  snapshot: Snapshot;
}) {
  return <div className="session-status-island">
    <LiveWorkIndicator snapshot={snapshot} />
    <ContextUsageIndicator snapshot={snapshot} />
  </div>;
}
