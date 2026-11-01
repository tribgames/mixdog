/**
 * What the S48 focus watch reports, and the one-line account of the keyboard
 * and mouse input its hooks saw around a step, which a user-input refusal is
 * judged against.
 */

export interface FocusWatchInput {
  at: number;
  kind: 'key' | 'pointer';
  injected: boolean;
  /** Only for injected input; physical keys carry no key identity. */
  vk?: number;
  flags?: number;
  extra?: number;
  message?: number;
  /** The foreground process when an injected event arrived. */
  foreground?: string;
}

export interface FocusWatch {
  samples: number;
  /** When the sentinel first held both the foreground and the focus, epoch ms; 0 if it never did. */
  armed_at: number;
  /** Samples since then where the foreground window or the keyboard focus was not the sentinel. */
  away: number;
  /** Keys since then not typed because the sentinel was not in front at that moment. */
  withheld: number;
  timed_out: boolean;
  /** When each key was typed into the sentinel, epoch ms. */
  typed: number[];
  /** Every change of foreground window or focus root, the first sample included. */
  changes: Array<{ at: number; foreground: number; focus: number }>;
  /** Keyboard and mouse input the helper's own low-level hooks saw, its own typing left out. */
  inputs: FocusWatchInput[];
  /** Moves of the system's last-input clock with no hooked event within 100 ms of them. */
  clock: number[];
  counts: { physical_keys: number; physical_pointer: number; injected: number; self_typed: number };
}

/** One foreground window and focus root the watch sampled, and when. */
export interface FrontSample {
  at: number;
  foreground: number;
  focus: number;
}

/** Whether OS samples show `target` holding the foreground: S48's control
 *  proof. The fixture's own `focused` flag is Electron's isFocused(), which
 *  can be true while the OS foreground never moved, so it is no proof. */
export function controlTookForeground(samples: readonly FrontSample[], target: number): boolean {
  return samples.some((sample) => sample.foreground === target);
}

/** One stretch, after the watch armed, in which the foreground window or the
 *  keyboard focus was not the sentinel: from the change that left it to the
 *  change that gave both back, undefined while it never came back. */
export interface FocusExcursion {
  from: number;
  to: number | undefined;
  foreground: number;
  focus: number;
  /** Keys the watch typed inside it. */
  typed: number;
}

export function focusExcursions(
  watch: Pick<FocusWatch, 'armed_at' | 'changes' | 'typed'>,
  sentinel: number
): FocusExcursion[] {
  const excursions: FocusExcursion[] = [];
  let open: FocusExcursion | undefined;
  for (const change of watch.changes) {
    if (!watch.armed_at || change.at < watch.armed_at) continue;
    const onSentinel = change.foreground === sentinel && change.focus === sentinel;
    if (!onSentinel && !open) {
      open = { from: change.at, to: undefined, foreground: change.foreground, focus: change.focus, typed: 0 };
      excursions.push(open);
    } else if (onSentinel && open) {
      open.to = change.at;
      open = undefined;
    }
  }
  for (const excursion of excursions) {
    excursion.typed = watch.typed.filter(
      (at) => at >= excursion.from && (excursion.to === undefined || at <= excursion.to)
    ).length;
  }
  return excursions;
}

export interface FocusLockRun {
  action: string;
  sentAt: number;
  repliedAt: number;
}

/** The target fixture saying it was focused: an activation whose
 *  BrowserWindow.isFocused() answered true, or a BrowserWindow focus event.
 *  Electron reports both for an activation local to the target's own thread
 *  that never makes it the foreground window, so only the OS watch decides. */
export interface FocusClaim {
  label: string;
  at: number;
}

/** Tolerance between the fixture's and the watch's reads of the system clock. */
const CLOCK_SLACK_MS = 25;

/** S48's verdict from the OS watch: every excursion from the sentinel belongs
 *  to an action, ends with the sentinel holding both foreground and focus
 *  again, and lasts at most `boundMs`. A fixture focus claim inside an
 *  excursion is covered by that; outside one it fails only when the watch
 *  shows the target holding the foreground or focus around it, and is
 *  otherwise reported as a note. */
export function judgeFocusLock(input: {
  watch: Pick<FocusWatch, 'armed_at' | 'changes' | 'typed' | 'withheld'>;
  sentinel: number;
  target: number;
  runs: FocusLockRun[];
  settleMs: number;
  boundMs: number;
  claims: FocusClaim[];
}): {
  excursions: Array<FocusExcursion & { run: number | undefined }>;
  exposure: string;
  notes: string[];
  failures: string[];
} {
  const { watch, sentinel, target, runs } = input;
  const name = (hwnd: number) =>
    hwnd === sentinel ? 'the sentinel' : hwnd === target ? 'the target' : `0x${hwnd.toString(16)}`;
  const runIndex = (at: number) => {
    const index = runs.findIndex((run) => at >= run.sentAt && at <= run.repliedAt + input.settleMs);
    return index < 0 ? undefined : index;
  };
  const excursions = focusExcursions(watch, sentinel).map((excursion) => ({
    ...excursion,
    run: runIndex(excursion.from),
  }));
  const lengthOf = (excursion: FocusExcursion) =>
    excursion.to === undefined ? Number.POSITIVE_INFINITY : excursion.to - excursion.from;
  const describeExcursion = (excursion: (typeof excursions)[number]) => {
    const run = excursion.run === undefined ? undefined : runs[excursion.run];
    return (
      `the foreground went to ${name(excursion.foreground)} and the focus to ${name(excursion.focus)}` +
      (run
        ? ` ${excursion.from - run.sentAt} ms after the ${run.action} request (reply at ${run.repliedAt - run.sentAt} ms)`
        : ' outside any action') +
      (excursion.to === undefined ? ' and never came back' : ` for ${excursion.to - excursion.from} ms`)
    );
  };
  const failures: string[] = [];
  for (const excursion of excursions) {
    const text = describeExcursion(excursion);
    if (excursion.run === undefined) failures.push(text);
    else if (excursion.to === undefined) failures.push(`${text}: the sentinel did not get both back`);
    else if (lengthOf(excursion) > input.boundMs) failures.push(`${text}, over the ${input.boundMs} ms bound`);
  }
  const notes: string[] = [];
  for (const claim of input.claims) {
    const inside = excursions.some(
      (excursion) =>
        claim.at >= excursion.from - CLOCK_SLACK_MS &&
        claim.at <= (excursion.to ?? Number.POSITIVE_INFINITY) + CLOCK_SLACK_MS
    );
    if (inside) continue;
    // The OS state at the claim: the last change before it, and any within the slack.
    const before = watch.changes.filter((change) => change.at <= claim.at - CLOCK_SLACK_MS).at(-1);
    const near = watch.changes.filter((change) => Math.abs(change.at - claim.at) <= CLOCK_SLACK_MS);
    const held = [...(before ? [before] : []), ...near].find(
      (change) => change.foreground === target || change.focus === target
    );
    if (held) {
      failures.push(
        `${claim.label}: the OS watch shows the target holding the foreground or focus at ${held.at} outside any excursion`
      );
    } else {
      notes.push(
        `${claim.label}: the fixture reported the target focused, but the OS foreground and focus did not move to it`
      );
    }
  }
  const exposure =
    `${excursions.length} excursions from the sentinel, longest ` +
    `${excursions.length ? Math.max(...excursions.map(lengthOf)) : 0} ms, ` +
    `${excursions.reduce((sum, excursion) => sum + excursion.typed, 0)} keys typed during them, ` +
    `${watch.withheld} keys withheld while the sentinel was not in front` +
    (excursions.length ? `; ${excursions.map(describeExcursion).join('; ')}` : '');
  return { excursions, exposure, notes, failures };
}

/** The exposure one action's foreground_lock facts show. Times are on the
 *  QueryPerformanceCounter clock the worker and the host's lease thread share,
 *  so each is given against the lock's acquisition: when the action was
 *  dispatched and returned, the deadline, and when the hold ended, with how
 *  it ended and what the restore did. */
export function describeForegroundLock(facts: unknown): string {
  if (!facts || typeof facts !== 'object') return 'no foreground_lock facts';
  const worker = facts as Record<string, unknown>;
  const host = (worker.host && typeof worker.host === 'object' ? worker.host : {}) as Record<string, unknown>;
  const holder = String(worker.holder ?? 'none');
  const held = holder === 'host' ? host : worker;
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const acquiredAt = number(held.acquired_at);
  const since = (label: string, value: unknown) => {
    const at = number(value);
    return acquiredAt === undefined || at === undefined
      ? `${label} n/a`
      : `${label} +${(at - acquiredAt).toFixed(1)} ms`;
  };
  const asked = worker.host_answer === undefined ? [] : [`host ${String(host.answer ?? worker.host_answer)}`];
  const lease = number(host.lease) ? [`lease ${host.lease}`] : [];
  return [
    `holder ${holder}`,
    ...asked,
    ...lease,
    since('dispatched', worker.dispatched_at),
    since('returned', worker.returned_at),
    since('deadline', held.deadline_at),
    `${since('ended', held.ended_at)} (${number(held.late_ms) ?? 'n/a'} ms past the deadline) by ${String(held.released_by ?? 'n/a')}`,
    since('steal seen', worker.steal_seen_at),
    `unlock errors ${JSON.stringify(held.unlock_errors ?? null)}`,
    `release ${String(worker.release ?? 'n/a')}`,
    `restore ${String(worker.restore ?? 'n/a')}`,
  ].join(', ');
}

/** One action's lock against the harness's own wall-clock evidence: the
 *  worker's `requested_epoch_ms` anchors its clock, so the target's own
 *  activation attempts (whether each got the foreground), the foreground
 *  changes and the keys the watch typed are placed against the hold. */
export function describeLockTimeline(
  facts: unknown,
  watch: Pick<FocusWatch, 'typed' | 'changes'>,
  activations: Array<{ at: number; focused: boolean }>
): string {
  if (!facts || typeof facts !== 'object') return 'no foreground_lock facts';
  const worker = facts as Record<string, unknown>;
  const host = (worker.host && typeof worker.host === 'object' ? worker.host : {}) as Record<string, unknown>;
  const held = worker.holder === 'host' ? host : worker;
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const epoch = number(worker.requested_epoch_ms);
  const requested = number(worker.requested_at);
  const acquired = number(held.acquired_at);
  if (epoch === undefined || requested === undefined || acquired === undefined) return 'no lock timeline';
  // Epoch ms of a QueryPerformanceCounter stamp, then given against acquisition.
  const toEpoch = (value: unknown) => {
    const at = number(value);
    return at === undefined ? undefined : epoch + (at - requested);
  };
  const acquiredEpoch = epoch + (acquired - requested);
  const ended = toEpoch(held.ended_at) ?? toEpoch(held.deadline_at) ?? acquiredEpoch;
  const rel = (at: number) => `${at - acquiredEpoch >= 0 ? '+' : ''}${(at - acquiredEpoch).toFixed(0)} ms`;
  const window = (at: number) => at >= acquiredEpoch - 50 && at <= ended + 1_000;
  const attempts = activations
    .filter((attempt) => window(attempt.at))
    .map((attempt) => `${rel(attempt.at)} ${attempt.focused ? 'got the foreground' : 'refused'}`);
  const changes = watch.changes
    .filter((change) => window(change.at))
    .map((change) => `${rel(change.at)} 0x${change.foreground.toString(16)}`);
  const typed = watch.typed.filter((at) => at >= acquiredEpoch && at <= ended);
  return (
    `lock ${rel(acquiredEpoch)} to ${rel(ended)}; target activations [${attempts.join('; ')}]; ` +
    `foreground changes [${changes.join('; ')}]; ${typed.length} keys typed during the hold` +
    (typed.length ? ` (last ${rel(typed.at(-1) as number)})` : '')
  );
}

export function describeWatchedInput(watch: Pick<FocusWatch, 'inputs' | 'clock'>, from: number, to: number): string {
  const inside = watch.inputs.filter((input) => input.at >= from && input.at <= to);
  const keys = inside.filter((input) => input.kind === 'key' && !input.injected).length;
  const pointer = inside.filter((input) => input.kind === 'pointer' && !input.injected).length;
  const injected = inside.filter((input) => input.injected);
  const unexplained = watch.clock.filter((at) => at >= from && at <= to);
  const injectedText = injected
    .map(
      (input) =>
        `${input.kind}${input.vk !== undefined ? ` vk 0x${input.vk.toString(16)}` : ''}` +
        `${input.message !== undefined ? ` message 0x${input.message.toString(16)}` : ''}` +
        ` flags 0x${(input.flags ?? 0).toString(16)} extra ${input.extra ?? 0} at +${input.at - from} ms` +
        ` (foreground ${input.foreground || '?'})`
    )
    .join('; ');
  return (
    `harness hooks from ${new Date(from).toISOString()} for ${to - from} ms: ${keys} physical key events, ` +
    `${pointer} physical pointer events, ${injected.length} injected events${injectedText ? ` [${injectedText}]` : ''}, ` +
    `${unexplained.length} last-input clock moves no hooked event explains` +
    (unexplained.length ? ` (at +${unexplained.map((at) => at - from).join(', +')} ms)` : '')
  );
}
