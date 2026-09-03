// One idle lane for every post-boot warm-up (user: 부트 / 메뉴 진입 / 설정값
// 반응성). Before this lane, five independent timers — settings sweep, rail
// panel mounts, transcript reads, chunk fetches, dock git status — all fired
// inside the same two seconds after the window appeared and stacked on the
// main thread: a keystroke typed right after boot painted 150–170ms late.
// The lane runs ONE task per idle slice, lowest priority number first, and
// yields back to the browser between tasks so live input always wins.
export interface BootWarmupTask {
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
  utilityDockModule: 30,
  dockGitState: 40,
  dockBody: 45,
  transcript: 50,
  surfaceChunk: 60,
  /** Hidden mount of the composer's full model list, so the Model row opens
   *  onto rows that already exist. */
  modelCatalog: 65,
  studioModule: 70,
  commandSurfaceModule: 72,
  settingsPreload: 80,
  settingsMount: 85,
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
/** Input wins: a key or pointer press this recently defers the next task, so
 *  a keystroke typed right after boot never queues behind a hidden mount. */
const INPUT_QUIET_MS = 300;

let lastInputAt = 0;
let inputListening = false;
function listenForInput(): void {
  if (inputListening || typeof window === "undefined") return;
  inputListening = true;
  const note = () => { lastInputAt = Date.now(); };
  window.addEventListener("keydown", note, { capture: true, passive: true });
  window.addEventListener("pointerdown", note, { capture: true, passive: true });
}

const pending: BootWarmupTask[] = [];
let armed = false;
let running = false;
let idleHandle: number | null = null;
let gapHandle: number | null = null;
let host: IdleHost = typeof window === "undefined"
  ? { setTimeout: () => 0, clearTimeout: () => {} }
  : window as unknown as IdleHost;

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
  if (typeof window === "undefined") return;
  (window as unknown as { __mixdogBootWarmupDrained?: boolean })
    .__mixdogBootWarmupDrained = armed && !running && pending.length === 0;
}

function pump(): void {
  publishDrained();
  if (!armed || running || idleHandle !== null || gapHandle !== null) return;
  if (pending.length === 0) return;
  const onIdle = () => {
    idleHandle = null;
    const sinceInput = Date.now() - lastInputAt;
    if (sinceInput < INPUT_QUIET_MS) {
      gapHandle = host.setTimeout(() => {
        gapHandle = null;
        pump();
      }, INPUT_QUIET_MS - sinceInput);
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
    if (outcome && typeof (outcome as Promise<unknown>).then === "function") {
      (outcome as Promise<unknown>).then(settle, settle);
    } else {
      settle();
    }
  };
  if (typeof host.requestIdleCallback === "function") {
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
    const index = pending.findIndex((entry) => entry === task);
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
  if (nextHost) host = nextHost;
}

export function _noteBootWarmupInputForTest(at = Date.now()): void {
  lastInputAt = at;
}
