// Startup warm-up scheduling: stage heavy renderer chunks AFTER the first
// usable frame instead of during it. Markdown warms promptly (the first
// session open needs it); the much heavier diff surface waits for real user
// idle. Extracted from App.tsx so the component file holds UI only.
import { connectionQuality } from "./network-conditions";
import { preloadMarkdownBody, preloadStreamingMarkdownBody } from "./TranscriptView";
import { prewarmSidebarReferences } from "./sidebar-reference-cache";
import { loadStudioViewModule } from "./studio-loader";

type IdleHost = typeof window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
  __mixdogStartupSettled?: boolean;
  __mixdogWindowShown?: boolean;
};

export function schedulePostInteractionIdle(
  task: () => void,
  fallbackMs = 5_000,
  idleTimeout = 1_500,
  quietMs = 0,
): () => void {
  let stopped = false;
  let armed = false;
  let delay: number | undefined;
  let startupFallback: number | undefined;
  let idleHandle: number | undefined;
  const host = window as IdleHost;
  const removeInteractionListeners = () => {
    window.removeEventListener("pointerdown", postpone);
    window.removeEventListener("keydown", postpone);
  };
  const clearQueued = () => {
    window.clearTimeout(delay);
    delay = undefined;
    if (idleHandle !== undefined) {
      if (typeof host.cancelIdleCallback === "function") host.cancelIdleCallback(idleHandle);
      else window.clearTimeout(idleHandle);
      idleHandle = undefined;
    }
  };
  const run = () => {
    idleHandle = undefined;
    if (stopped) return;
    stopped = true;
    removeInteractionListeners();
    task();
  };
  const queueIdle = (wait = 0) => {
    clearQueued();
    delay = window.setTimeout(() => {
      delay = undefined;
      if (typeof host.requestIdleCallback === "function") {
        idleHandle = host.requestIdleCallback(run, { timeout: idleTimeout });
      } else {
        idleHandle = window.setTimeout(run, Math.min(idleTimeout, 250));
      }
    }, wait);
  };
  // Input POSTPONES heavy prewarm. The previous implementation used the first
  // click/key as its trigger, putting chunk evaluation directly behind the
  // first Dock open or upward wheel.
  const postpone = () => queueIdle(Math.max(600, quietMs));
  const arm = () => {
    if (stopped || armed) return;
    armed = true;
    window.clearTimeout(startupFallback);
    window.addEventListener("pointerdown", postpone);
    window.addEventListener("keydown", postpone);
    queueIdle(quietMs);
  };
  // Hidden BrowserWindow work can still hitch its first reveal. Main emits
  // this only after show + two composed frames. Browser/LAN clients use the
  // bounded fallback because they have no Electron main process.
  if (host.__mixdogWindowShown) arm();
  else {
    window.addEventListener("mixdog:window-shown", arm, { once: true });
    startupFallback = window.setTimeout(arm, Math.max(0, fallbackMs));
  }
  return () => {
    stopped = true;
    removeInteractionListeners();
    window.removeEventListener("mixdog:window-shown", arm);
    clearQueued();
    window.clearTimeout(startupFallback);
  };
}

// Markdown is part of normal conversation entry; Studio and the four sidebar
// rail panels (Projects/Workflows/Schedules/Webhooks) are lightweight primary
// destinations whose first-open chunk cost showed as a visible "Loading …"
// fallback (user: 로딩 생길 게 아닌데 왜 뜨냐). Monaco/xterm/diff remain
// behind explicit navigation intent because their retained heap is much
// larger.
// Second, lower-priority stage: once the panel chunks exist, fill the shared
// sidebar reference cache (channel setup, catalogs, workflows, agents) so the
// first Schedules/Webhooks/Workflows visit paints from memory instead of
// fetching. Data prewarm NEVER competes with the first frame or chunk work —
// it waits for another idle slot and stays cancellable.
export function startSidebarReferencePrewarm(delayMs = 250): () => void {
  let cancelled = false;
  const host = window as IdleHost;
  let idleHandle: number | undefined;
  const run = () => {
    idleHandle = undefined;
    if (cancelled) return;
    void prewarmSidebarReferences(window.mixdogDesktop);
  };
  const timer = window.setTimeout(() => {
    if (cancelled) return;
    if (typeof host.requestIdleCallback === "function") {
      idleHandle = host.requestIdleCallback(run, { timeout: 2_000 });
    } else {
      idleHandle = window.setTimeout(run, 0);
    }
  }, Math.max(0, delayMs));
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    if (idleHandle === undefined) return;
    if (typeof host.cancelIdleCallback === "function") host.cancelIdleCallback(idleHandle);
    else window.clearTimeout(idleHandle);
    idleHandle = undefined;
  };
}

export function scheduleRendererWarmups(): () => void {
  let stopped = false;
  let cancelPrewarm: (() => void) | undefined;
  const nativeWindow = Boolean(window.mixdogDesktop?.bootContext?.bootId);
  // First chat needs Markdown before idle. Studio/rail chunks stay deferred.
  void preloadMarkdownBody().catch(() => undefined);
  void preloadStreamingMarkdownBody().catch(() => undefined);
  // A browser/phone downloads these panel chunks over the same link the first
  // screen is still using, so a metered or slow connection skips the warmup
  // entirely and pays the chunk cost only for a panel the user actually
  // opens. The native window reads them from local disk and always warms.
  if (!nativeWindow && connectionQuality() !== "normal") {
    return () => { stopped = true; };
  }
  const cancelIdle = schedulePostInteractionIdle(
    () => {
      void Promise.allSettled([
        loadStudioViewModule(),
        import("./SchedulesView"),
        import("./WebhooksView"),
        import("./WorkflowsView"),
        import("./ProjectsView"),
      ]).then(() => {
        if (!stopped) {
          cancelPrewarm = startSidebarReferencePrewarm(nativeWindow ? 250 : 0);
        }
      });
    },
    // The browser has no `mixdog:window-shown` signal, so its numbers are the
    // fallback path: wait out the opening screen's own transfers, then take a
    // real idle slot. Starting at zero put these chunks in the download queue
    // ahead of the session data the user was waiting for.
    nativeWindow ? 2_500 : 2_000,
    nativeWindow ? 800 : 800,
    nativeWindow ? 100 : 250,
  );
  return () => {
    stopped = true;
    cancelIdle();
    cancelPrewarm?.();
  };
}

if (typeof window !== "undefined") {
  const cancelWarmups = scheduleRendererWarmups();
  window.addEventListener("beforeunload", cancelWarmups, { once: true });
}
