// One idle lane for every post-boot warm-up (user: 부트 / 메뉴 진입 / 설정값
// 반응성). Before this lane, five independent timers — settings sweep, rail
// panel mounts, transcript reads, chunk fetches, dock git status — all fired
// inside the same two seconds after the window appeared and stacked on the
// main thread: a keystroke typed right after boot painted 150–170ms late.
// The lane runs ONE task per idle slice, lowest priority number first, and
// yields back to the browser between tasks so live input always wins.
interface BootWarmupTask {
  /** Stable id: re-scheduling the same id replaces the pending task. */
  id: string;
  /** Lower runs first. */
  priority: number;
  run(): unknown;
}

/** Lane order. Rail menus first (a click lands there soonest), then the
 *  focused pane's dock, then open-tab transcripts and their chunks, and the
 *  settings sweep last — it only has to beat the user to the gear icon. */
export const BOOT_WARMUP = Object.freeze({
  sidebarPanel: 20,
  /** The rail usage flyout, so its first open paints rows, not a placeholder. */
  usageFlyoutModule: 25,
  /** The Monaco editor and Markdown preview chunks, so the first file open
   *  hydrates at once; ahead of the slow lane tail because a file is the
   *  first thing most sessions open. */
  editorModule: 27,
  /** The Studio chunk, so its first open mounts without a placeholder frame. */
  studioModule: 28,
  utilityDockModule: 30,
  /** A phone's agent catalog read, held off its first screen. */
  agentPool: 35,
  dockGitState: 40,
  /** The Search file tree's root listing, so its first open paints rows. */
  dockExplorerRoot: 42,
  dockBody: 45,
  transcript: 50,
  /** Goal capsule, so the first Goal session entered after boot shows it in
   *  the same frame as its transcript. */
  sessionGoalModule: 55,
  surfaceChunk: 60,
  /** The most recent sidebar sessions not open in a pane, so the first
   *  click after launch paints from the lane, not a cold disk parse. */
  recentTranscript: 62,
  /** Hidden mount of the composer's full model list, so the Model row opens
   *  onto rows that already exist. */
  modelCatalog: 65,
  commandSurfaceModule: 72,
  /** The subscription usage that dialog opens on, so its first open paints
   *  instead of waiting on a cold ledger read. */
  quotaUsage: 74,
  settingsPreload: 80,
  settingsMount: 85,
  /** A phone's side-sheet pane chunks (diff, Terminal, Browser, Visualize, editor),
   *  downloaded only — they evaluate on their first open: the lane's tail,
   *  after everything its first screen needs. */
  phoneSheetPane: 90,
});

interface IdleHost {
  requestIdleCallback?(callback: () => void, options?: { timeout?: number }): number;
  cancelIdleCallback?(handle: number): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** The lane opens this long after the window's first frames: the opening
 *  conversation paints and a first keystroke lands inside that window. */
export const BOOT_WARMUP_ARM_DELAY_MS = 600;
/** Idle slices must still arrive on a busy thread: the timeout keeps the lane
 *  moving under sustained streaming without letting it preempt input. */
const IDLE_TIMEOUT_MS = 2_000;
/** Breath between tasks so two warm-ups never land in one frame. */
const TASK_GAP_MS = 120;
/** Input wins: a key or pointer press, or a scroll the user drives, this
 *  recently defers the next task, so a keystroke typed right after boot never
 *  queues behind a hidden mount and a scroll never stutters behind one. */
const INPUT_QUIET_MS = 300;

let lastInputAt = 0;
let inputListening = false;
/** A touch drag's scroll is still running: the compositor keeps flinging
 *  after the finger lifts and reports only `scroll` events. */
let dragScrolling = false;
function listenForInput(): void {
  if (inputListening || typeof window === 'undefined') return;
  inputListening = true;
  const options = { capture: true, passive: true } as const;
  const note = () => {
    lastInputAt = Date.now();
  };
  window.addEventListener('keydown', note, options);
  window.addEventListener('pointerdown', note, options);
  window.addEventListener('wheel', note, options);
  // A phone's first swipe released the lane on its single pointerdown, so rail
  // mounts and pane chunks (Monaco) ran in the idle slices of the scroll itself
  // and the first seconds of scrolling stuttered. The drag and its fling count
  // as input. A programmatic scroll (the transcript following a stream) starts
  // no chain; a pause longer than the quiet window or `scrollend` ends one.
  window.addEventListener(
    'touchmove',
    () => {
      dragScrolling = true;
      note();
    },
    options
  );
  window.addEventListener(
    'scroll',
    () => {
      if (!dragScrolling) return;
      if (Date.now() - lastInputAt < INPUT_QUIET_MS) note();
      else dragScrolling = false;
    },
    options
  );
  window.addEventListener(
    'scrollend',
    () => {
      if (!dragScrolling) return;
      dragScrolling = false;
      note();
    },
    options
  );
}

/** Milliseconds until input has been quiet long enough for background work;
 *  0 means now. Other post-boot warm-ups (fonts) share the lane's input gate. */
export function inputQuietRemainingMs(): number {
  listenForInput();
  return Math.max(0, INPUT_QUIET_MS - (Date.now() - lastInputAt));
}

const pending: BootWarmupTask[] = [];
let armed = false;
let running = false;
let idleHandle: number | null = null;
let gapHandle: number | null = null;
let host: IdleHost =
  typeof window === 'undefined' ? { setTimeout: () => 0, clearTimeout: () => {} } : (window as unknown as IdleHost);

function nextTask(): BootWarmupTask | undefined {
  if (pending.length === 0) return undefined;
  let best = 0;
  for (let index = 1; index < pending.length; index += 1) {
    if (pending[index].priority < pending[best].priority) best = index;
  }
  return pending.splice(best, 1)[0];
}

function publishDrained(): void {
  // Probe hook: the boot-scenario harness waits for a drained lane before it
  // measures menu entry, so it times a WARM app rather than the warm-up.
  if (typeof window === 'undefined') return;
  (window as unknown as { __mixdogBootWarmupDrained?: boolean }).__mixdogBootWarmupDrained =
    armed && !running && pending.length === 0;
}

function pump(): void {
  publishDrained();
  if (!armed || running || idleHandle !== null || gapHandle !== null) return;
  if (pending.length === 0) return;
  const onIdle = () => {
    idleHandle = null;
    const quietIn = inputQuietRemainingMs();
    if (quietIn > 0) {
      gapHandle = host.setTimeout(() => {
        gapHandle = null;
        pump();
      }, quietIn);
      return;
    }
    const task = nextTask();
    if (!task) return;
    running = true;
    let outcome: unknown;
    try {
      outcome = task.run();
    } catch {
      outcome = undefined;
    }
    const settle = () => {
      running = false;
      gapHandle = host.setTimeout(() => {
        gapHandle = null;
        pump();
      }, TASK_GAP_MS);
    };
    if (outcome && typeof (outcome as Promise<unknown>).then === 'function') {
      (outcome as Promise<unknown>).then(settle, settle);
    } else {
      settle();
    }
  };
  if (typeof host.requestIdleCallback === 'function') {
    idleHandle = host.requestIdleCallback(onIdle, { timeout: IDLE_TIMEOUT_MS });
  } else {
    idleHandle = host.setTimeout(onIdle, 50);
  }
}

/** Queue a warm-up. Returns a cancel for effect cleanup; a task already
 *  running is never interrupted. */
export function scheduleBootWarmup(task: BootWarmupTask): () => void {
  const existing = pending.findIndex((entry) => entry.id === task.id);
  if (existing >= 0) pending.splice(existing, 1);
  pending.push(task);
  pump();
  return () => {
    const index = pending.indexOf(task);
    if (index >= 0) pending.splice(index, 1);
  };
}

/** Opens the lane. Tasks scheduled earlier stay parked until this fires, so
 *  registration order never decides what runs during the boot cover. */
export function armBootWarmup(delayMs = 0): void {
  if (armed) return;
  armed = true;
  listenForInput();
  if (delayMs > 0 && gapHandle === null) {
    // Leave the first moments after the window shows to the user: the
    // opening conversation and a first keystroke both land in this window.
    gapHandle = host.setTimeout(() => {
      gapHandle = null;
      pump();
    }, delayMs);
    return;
  }
  pump();
}

export function _bootWarmupPendingForTest(): readonly string[] {
  return pending.map((task) => task.id);
}

export function _resetBootWarmupForTest(nextHost?: IdleHost): void {
  if (idleHandle !== null) {
    host.cancelIdleCallback?.(idleHandle);
    host.clearTimeout(idleHandle);
  }
  if (gapHandle !== null) host.clearTimeout(gapHandle);
  pending.length = 0;
  armed = false;
  running = false;
  idleHandle = null;
  gapHandle = null;
  lastInputAt = 0;
  dragScrolling = false;
  if (nextHost) host = nextHost;
}

export function _noteBootWarmupInputForTest(at = Date.now()): void {
  lastInputAt = at;
}
