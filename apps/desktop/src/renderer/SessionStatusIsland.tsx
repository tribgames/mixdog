import { Activity, PanelRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { liveAgentRows, liveShellCount, liveShellRows } from './AgentActivityPane';
import { desktopCancelOutcome } from '../shared/agent-activity';
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
const SHELL_EXECUTION_MARKER = /^(?:-c|--command|-command|-file|\/c)$/i;

function shellCommandLabel(command: string): string {
  const source = command.replace(/\s+/g, ' ').trim();
  if (!source) return '';
  let tokens: string[] = source.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g) || [];
  const clean = (token: string) => token.replace(/^["']+|["']+$/g, '');
  // A wrapper shell hides the real command behind its own switches.
  while (tokens.length > 1 && SHELL_WRAPPER.test(clean(tokens[0] || '').replace(/^.*[\\/]/, ''))) {
    const rest = tokens.slice(1);
    const marker = rest.findIndex((token) => SHELL_EXECUTION_MARKER.test(clean(token)));
    if (marker >= 0 && marker + 1 < rest.length) {
      tokens = rest.slice(marker + 1);
      if (tokens.length === 1 && clean(tokens[0]) !== tokens[0]) {
        return shellCommandLabel(clean(tokens[0]));
      }
      continue;
    }
    const subject = rest.findIndex((token) => !/^[-/]/.test(clean(token)));
    if (subject < 0) break;
    tokens = rest.slice(subject);
  }
  const words: string[] = [];
  for (const token of tokens) {
    const word = clean(token);
    if (!word) continue;
    if (/^(?:&&|\|\||[|;])$/.test(word)) break;
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
export function LiveWorkIndicator({ snapshot, open: controlledOpen, onOpenChange }: {
  snapshot: Snapshot;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
    kind: 'agent' | 'shell';
    label: string;
    detail: string;
    meta?: string;
    title?: string;
    /** What a Stop press ends: an agent's running turn, or one background
     *  shell task. An aggregate count row addresses nothing and gets no
     *  button — there is no single job behind it to cancel. */
    stop?: { kind: 'agent' | 'shell'; id: string };
  }[] = [];
  for (const agent of agents) {
    rows.push({
      key: agent.key,
      kind: 'agent',
      label: agent.role,
      // A cancel that could not be confirmed keeps its row — the process may
      // still be alive — but it says so instead of borrowing the work timer.
      detail: agent.state === 'cancel-unconfirmed'
        ? t('Cancel unconfirmed')
        : agent.queued
          ? t('Queued')
          : elapsed(agent.turnStartedAt || agent.startedAt) || agent.status,
      ...(agent.state === 'cancel-unconfirmed'
        ? { title: t('Cancel was delivered, but the process could not be confirmed stopped.') }
        : {}),
      ...(agent.tag ? { stop: { kind: 'agent' as const, id: agent.tag } } : {}),
    });
  }
  if (agentCount > agents.length) {
    rows.push({
      key: 'agent-tools',
      kind: 'agent',
      label: `${t('Agent')} ${agentCount - agents.length}`,
      detail: elapsed(Number(snapshot.activeTools?.agent?.startedAt) || 0),
    });
  }
  for (const shell of shells) {
    rows.push({
      key: shell.key,
      kind: 'shell',
      label: shellCommandLabel(shell.command) || t('Shell'),
      detail: elapsed(shell.startedAt),
      meta: shell.cwd,
      title: shell.command,
      // The row already carries the job's own task id, so Stop ends THAT
      // background command and leaves the turn itself running.
      stop: { kind: 'shell', id: shell.key },
    });
  }
  if (shellCount > shells.length) {
    rows.push({
      key: 'shell-jobs',
      kind: 'shell',
      label: `${t('Shell')} ${shellCount - shells.length}`,
      detail: String(snapshot.shellJobs?.elapsedLabel || ''),
    });
  }
  const groups = ([
    {
      kind: 'agent' as const,
      label: agentCount === 1 ? t('Agent') : t('Agents'),
      count: agentCount,
      rows: rows.filter((row) => row.kind === 'agent'),
    },
    {
      kind: 'shell' as const,
      label: t('Shell'),
      count: shellCount,
      rows: rows.filter((row) => row.kind === 'shell'),
    },
  ]).filter((group) => group.rows.length > 0);
  // A coarse pointer has no hover to read the card with, so there a tap opens
  // the same card the desktop shows on hover, and the next pointer landing
  // outside it — or Escape — puts it away again.
  const touch = touchPrimaryPointer();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  }, [controlledOpen, onOpenChange]);
  const [pinned, setPinned] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && host.current?.contains(target)) return;
      setPinned(false);
      setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPinned(false);
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
    };
  }, [open, setOpen]);
  useEffect(() => {
    if (controlledOpen === false) setPinned(false);
  }, [controlledOpen]);
  // ABB: the tapped-open activity card closes on hardware back.
  useMobileBack(open, () => {
    setPinned(false);
    setOpen(false);
  });
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
      const result = await window.mixdogDesktop.invokeCapability({
        ...request,
        ...(ownerSessionId ? { sessionId: ownerSessionId } : {}),
      });
      // A delivered signal is not a confirmed stop. Task control answers
      // `cancel-unconfirmed` when the exit could not be observed (on Windows a
      // git-bash background survivor is unreachable from JS and reports
      // SURVIVING_DESCENDANTS_UNREACHABLE_WARNING), and a silent return would
      // read as a successful cancel.
      if (desktopCancelOutcome(result?.value) === 'unconfirmed') {
        showDesktopToast(
          t('Cancel was delivered, but the process could not be confirmed stopped.'),
          'warn',
        );
      }
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
  return <div className="session-work-indicator" ref={host}
    data-active={total > 0 ? 'true' : 'false'}
    data-open={open ? 'true' : 'false'}
    onMouseEnter={() => { if (!touch) setOpen(true); }}
    onMouseLeave={() => { if (!touch && !pinned) setOpen(false); }}>
    {/* One fixed-width glyph keeps the capsule stable; the card carries detail. */}
    <button type="button"
      onClick={() => {
        const next = !pinned;
        setPinned(next);
        setOpen(next || (!touch && host.current?.matches(':hover') === true));
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!pinned && !host.current?.contains(event.relatedTarget)) setOpen(false);
      }}
      aria-expanded={open}
      aria-label={t('Background activity: {{count}} running', { count: total })}>
      <span className="session-work-icon-stack" aria-hidden="true">
        <Activity className="session-work-icon session-work-icon-base" size={18} />
        <Activity className="session-work-icon session-work-icon-glow" size={18} />
      </span>
    </button>
    {/* The card is ALWAYS mounted (user: 그냥 아예 안 나왔거든): an idle hover
        used to answer with nothing at all, so the slot read as dead chrome. */}
    <div className="live-work-popover" role="tooltip">
      {rows.length
        ? groups.map((group) => <section className="live-work-group"
          data-kind={group.kind} key={group.kind}>
          {/* Text only (user: TASK 아일랜드 버튼에 왼쪽 아이콘 빼주고): the
              group name already says agent or shell, so a leading glyph only
              pushed the label off the column its own rows start on. */}
          <header className="live-work-group-header">
            <span>{group.label}</span>
            <b>{group.count}</b>
          </header>
          {group.rows.map((row) => <div className="live-work-row" key={row.key}>
            <div className="live-work-copy">
              <span title={row.title}>{row.label}</span>
              {row.meta && <small title={row.meta}>{row.meta}</small>}
            </div>
            <time>{row.detail}</time>
            {row.stop && <button type="button" className="live-work-stop"
                disabled={stopping.has(`${row.stop.kind}:${row.stop.id}`)}
                aria-label={t('Stop')} title={t('Stop')}
                onClick={() => { void stop(row.stop as { kind: 'agent' | 'shell'; id: string }); }}>
              <MxIcon name="stop" size={12} />
            </button>}
          </div>)}
        </section>)
        : <div className="live-work-row" key="idle">
          <div className="live-work-copy">
            <span>{t('No background work')}</span>
          </div>
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
export function SessionStatusIsland({
  snapshot,
  onInherit,
  dockOpen = false,
  onToggleDock,
}: {
  snapshot: Snapshot;
  onInherit?: () => void;
  dockOpen?: boolean;
  onToggleDock?: () => void;
}) {
  const [openPanel, setOpenPanel] = useState<'work' | 'context' | null>(null);
  const sessionId = String(snapshot.sessionId || '');
  useEffect(() => setOpenPanel(null), [sessionId]);
  const setWorkOpen = useCallback((open: boolean) => {
    setOpenPanel((current) => open ? 'work' : current === 'work' ? null : current);
  }, []);
  const setContextOpen = useCallback((open: boolean) => {
    setOpenPanel((current) => open ? 'context' : current === 'context' ? null : current);
  }, []);
  return <div className="session-status-island">
    <LiveWorkIndicator snapshot={snapshot}
      open={openPanel === 'work'} onOpenChange={setWorkOpen} />
    <ContextUsageIndicator snapshot={snapshot}
      open={openPanel === 'context'} onOpenChange={setContextOpen}
      onInherit={onInherit} />
    {onToggleDock && <button type="button"
      className="session-dock-toggle session-status-dock-toggle"
      aria-pressed={dockOpen}
      aria-label={t(dockOpen ? 'Close {{label}}' : 'Open {{label}}', {
        label: t('utility panel'),
      })}
      data-tooltip={t(dockOpen ? 'Close {{label}}' : 'Open {{label}}', {
        label: t('utility panel'),
      })}
      onClick={() => {
        setOpenPanel(null);
        onToggleDock();
      }}>
      {/* Island voice is lucide line work (user: 아이콘 크기가 전혀 안 맞아 —
          채워진 거 말고 선으로 된 아이콘): the filled 16px codicon font glyph
          read heavier, brighter and off-size beside the 18px stroke marks. */}
      <PanelRight size={20} aria-hidden="true" />
    </button>}
  </div>;
}
