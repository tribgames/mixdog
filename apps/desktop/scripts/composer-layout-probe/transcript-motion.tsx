import React from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { PaneConversation } from "../../src/renderer/app-snapshot-views";
import { defaultSessionLaneStore } from "../../src/renderer/session-lane-store";
import { preloadMarkdownBody } from "../../src/renderer/markdown-body-loader";
import type { Snapshot, TranscriptItem } from "../../src/renderer/desktop-types";

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
const noop = () => {};
type Sample = ReturnType<typeof geometry>;

function geometry() {
  const viewport = document.querySelector<HTMLElement>(".transcript");
  if (!viewport) return null;
  const box = viewport.getBoundingClientRect();
  return {
    session: viewport.dataset.sessionKey,
    shown: !document.querySelector(".pane-surface-cover")
      && getComputedStyle(viewport).visibility !== "hidden",
    top: viewport.scrollTop,
    gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
    height: box.height,
    rows: [...viewport.querySelectorAll<HTMLElement>(".transcript-virtual-row")].map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        key: row.dataset.timelineKey!,
        top: rect.top,
        height: rect.height,
        visible: rect.bottom > box.top && rect.top < box.bottom,
        text: row.textContent?.slice(0, 48),
      };
    }),
  };
}

async function samples(count = 24) {
  const result: Sample[] = [];
  for (let n = 0; n < count; n++) {
    await frame();
    result.push(geometry());
  }
  return result;
}

function inspect(name: string, frames: Sample[], session: string, tail = true) {
  const final = frames.at(-1)!;
  const failures: string[] = [];
  const visible = frames.filter((value) => value?.shown && value.session === session);
  if (!final?.shown || final.session !== session || !final.rows.some((row) => row.visible)) {
    failures.push("incoming transcript never became visible");
  }
  const finalRows = new Map(final?.rows.map((row) => [row.key, row]) ?? []);
  let maxDrift = 0;
  for (const value of visible) {
    if (!value) continue;
    for (const row of value.rows) {
      const settled = finalRows.get(row.key);
      if (row.visible && settled) maxDrift = Math.max(maxDrift, Math.abs(row.top - settled.top));
    }
  }
  if (maxDrift > 1) failures.push(`visible rows move after first paint (${maxDrift.toFixed(1)}px)`);
  const maxGap = Math.max(0, ...visible.map((value) => Math.abs(value!.gap)));
  if (tail && maxGap > 1) failures.push(`visible tail is not pinned (${maxGap.toFixed(1)}px)`);
  let previous = "";
  return {
    name, failures, maxDrift, maxGap,
    frames: frames.flatMap((value, frame) => {
      const geometry = value && ({
      session: value.session, shown: value.shown, top: value.top, gap: value.gap,
      height: value.height,
      rows: value.rows.filter((row) => row.visible).map(({ key, top, height, text }) => ({ key, top, height, text })),
      });
      const signature = JSON.stringify(geometry);
      if (signature === previous) return [];
      previous = signature;
      return [{ frame, ...geometry }];
    }),
  };
}

/** Composer-dock geometry: the chrome above the input commits each real
 *  change exactly once. `expectedHeights` counts the distinct transcript
 *  viewport heights the frames may paint (1 = nothing moved). */
function inspectDock(name: string, frames: Sample[], session: string, expectedHeights: number) {
  const result = inspect(name, frames, session);
  const shown = frames.filter((value) => value?.shown && value.session === session);
  const heights = [...new Set(shown.map((value) => value!.height))];
  if (heights.length !== expectedHeights) {
    result.failures.push(`viewport committed ${heights.length} height(s) ${JSON.stringify(heights)}, expected ${expectedHeights}`);
  }
  // A legitimate one-time change moves the rows by exactly that change; only
  // an unchanged dock must keep every row still.
  if (expectedHeights > 1) {
    result.failures = result.failures.filter((failure) => !failure.startsWith("visible rows move"));
  }
  return result;
}

function history(id: string, mixed = false): Snapshot {
  const items: TranscriptItem[] = [];
  for (let n = 0; n < 30; n++) {
    items.push({ id: `${id}-user-${n}`, kind: "user", text: `Motion history ${n}` });
    if (mixed) items.push({
      id: `${id}-assistant-${n}`, kind: "assistant",
      text: `## Response ${n}\n\n`
        + "A measured paragraph whose wrapping changes when the conversation pane changes width. ".repeat(3)
        + "\n\n```typescript\n"
        + Array.from({ length: n % 5 + 3 }, (_, index) => `const value${index} = ${index};`).join("\n")
        + "\n```\n\n| Name | Value |\n| --- | --- |\n| Geometry | Stable |\n",
    });
    items.push({ id: `${id}-done-${n}`, kind: "turndone", text: "Done" });
  }
  return {
    sessionId: id, currentProject: "C:/Project/demo", items,
    busy: false, commandBusy: false, model: "probe",
  } as Snapshot;
}

export async function runTranscriptMotionProbe(root: Root) {
  // App gates session data on this module's readiness. Keep that production
  // prerequisite while still observing React's first lazy-body commit.
  await preloadMarkdownBody();
  let capability: (request: unknown) => Promise<{ value: unknown }> = async () => ({ value: null });
  (window as any).mixdogDesktop = {
    rendererDiagnostic: noop,
    perfLog: noop,
    invokeCapability: (request: unknown) => capability(request),
  };
  const cases: ReturnType<typeof inspect>[] = [];
  let width = 620;
  let session = "";
  // Only the composer-dock scenario lets the review bar ask its worker.
  let reviewActive = false;
  let acknowledge: ((value: boolean) => void) | undefined;
  let submissionId = "";
  const submit = (_content: unknown, options?: { id?: string }) => {
    submissionId = options?.id ?? "";
    return new Promise<boolean>((done) => { acknowledge = done; });
  };
  const publish = (snapshot: Snapshot) => defaultSessionLaneStore.apply({
    sessionId: String(snapshot.sessionId), snapshot,
  });
  const render = () => root.render(
    <div style={{ height: 620, width, margin: 30, display: "flex", position: "relative" }}>
      <PaneConversation focused sessionId={session} hidden={false} reconcileOnMount={false}
        invokeResult={async (fn) => fn()} errors={[]} submit={submit}
        applySnapshot={noop} transitioning={false} composerFocusRequest={0}
        onNewTask={noop} onClearProject={noop} onResumeSession={noop} onOpenSessions={noop}
        onOpenProjects={noop} projects={[]} showProjectSelector={false}
        activeProjectPath="C:/Project/demo" activeProjectLabel="demo" onSelectProject={noop}
        onOpenCommandSurface={noop} reviewActive={reviewActive} />
    </div>,
  );
  const enter = async (name: string, snapshot: Snapshot, prepared = true) => {
    session = String(snapshot.sessionId);
    if (prepared) publish(snapshot);
    flushSync(render);
    const frames = await samples(prepared ? 24 : 3);
    if (!prepared) {
      flushSync(() => publish(snapshot));
      frames.push(...await samples());
    }
    cases.push(inspect(name, frames, session));
  };
  try {
    const plain = history("motion-plain");
    const mixed = history("motion-mixed", true);
    await enter("cold-mount", plain);
    await enter("prepared-session-switch", mixed);
    await enter("delayed-session-switch", history("motion-delayed", true), false);
    await enter("return-to-plain", plain);
    width = 420;
    await enter("cached-session-at-new-width", mixed);

    // A submit after an upward reader gesture must take the tail immediately,
    // not wait for the previous session/gesture's idle window to expire.
    for (const reading of [false, true]) {
      const snapshot = history(`motion-submit-${reading ? "reading" : "tail"}`, true);
      await enter(`prepare-submit-${reading ? "reading" : "tail"}`, snapshot);
      const input = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
      const prompt = "Motion next prompt\nSecond line\nThird line\nFourth line";
      input.focus({ preventScroll: true });
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, prompt);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await samples(3);
      if (reading) {
        const viewport = document.querySelector<HTMLElement>(".transcript")!;
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
        viewport.scrollTop -= 240;
        viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
        await samples(2);
      }
      const before = geometry();
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", bubbles: true, cancelable: true,
      }));
      const frames = await samples(8);
      acknowledge?.(true);
      await frame();
      flushSync(() => publish({
        ...snapshot, busy: true,
        items: [...(snapshot.items ?? []), { kind: "user", id: submissionId, text: prompt }],
      }));
      frames.push(...await samples(12));
      const result = inspect(`submit-${reading ? "reading" : "tail"}`, frames, session);
      if (!frames.some((value) => value?.rows.some((row) =>
        row.visible && row.text?.includes("Motion next prompt")))) {
        result.failures.push("submitted prompt never became visible");
      }
      cases.push({ ...result, frames: [
        { phase: "before-submit", ...before } as any, ...result.frames,
      ] });
    }

    // Idle reader position must remain the same when a new item arrives; the
    // entry/submit fix must not turn every append into a forced bottom pin.
    const reader = history("motion-reader", true);
    await enter("prepare-reader", reader);
    const viewport = document.querySelector<HTMLElement>(".transcript")!;
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -260, bubbles: true }));
    viewport.scrollTop -= 260;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    await samples(30);
    const before = geometry();
    flushSync(() => publish({
      ...reader, items: [...(reader.items ?? []), { kind: "user", id: "background-append", text: "Background append" }],
    }));
    const after = await samples(12);
    const result = inspect("reader-preserved-on-append", [before, ...after], session, false);
    if (document.querySelector<HTMLElement>(".transcript")?.dataset.following !== "false") {
      result.failures.push("background append rearmed follow while reading");
    }
    cases.push(result);

    // Chrome above the composer (Goal capsule + turn-review bar) commits its
    // geometry ONCE per real change. The bar's authoritative worker read lands
    // AFTER the transcript is shown and must fill the reserved slot; Goal
    // republications that carry a new object or only clock fields must not
    // move a row; clearing the Goal moves the rows exactly once.
    const patch = "diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-before\n+after";
    const chrome = history("motion-chrome", true);
    chrome.items = [
      ...(chrome.items ?? []),
      { id: "chrome-user", kind: "user", text: "Change demo.txt" },
      { id: "chrome-patch", kind: "tool", name: "apply_patch", args: {}, result: "Updated demo.txt", uiDiff: patch },
      { id: "chrome-done", kind: "turndone", text: "Done" },
    ] as TranscriptItem[];
    const goal = { id: "goal-chrome", status: "active", title: "Chrome goal", objective: "Keep chrome stable", tasks: [] };
    (chrome as any).goal = goal;
    // The probe window is hidden; the review bar only asks its worker on a
    // visible document, so the entry must look visible to exercise the late
    // result. Restored before the root unmounts.
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    let resolved = false;
    let requests = 0;
    capability = () => new Promise((done) => {
      requests += 1;
      // Land strictly AFTER the transcript is on screen: the late result is
      // the case under test, not a read that beats the reveal.
      let shownFrames = 0;
      const tick = () => {
        if (geometry()?.shown) shownFrames += 1;
        if (shownFrames < 3) {
          requestAnimationFrame(tick);
          return;
        }
        resolved = true;
        done({ value: {
          authoritative: true, checkpointId: "chrome-user", snapshotKind: "worktree",
          files: [{ path: "demo.txt", status: "M", additions: 1, deletions: 1 }], patch, agents: [],
        } });
      };
      requestAnimationFrame(tick);
    });
    session = String(chrome.sessionId);
    reviewActive = true;
    publish(chrome);
    flushSync(render);
    const chromeFrames = await samples(24);
    const chromeEntry = inspectDock("async-chrome-entry", chromeFrames, session, 1);
    if (!resolved) chromeEntry.failures.push(`review worker never resolved (requests=${requests}, reserved=${document.querySelector(".turn-review-slot")?.getAttribute("data-reserved")})`);
    if (!document.querySelector(".turn-review-bar")) chromeEntry.failures.push("review bar missing after worker resolution");
    if (!document.querySelector(".session-goal-island")) chromeEntry.failures.push("goal capsule missing on entry");
    cases.push(chromeEntry);
    const republish = async (name: string, next: Snapshot, expectedHeights: number, capsule: boolean) => {
      const before = geometry();
      flushSync(() => publish(next));
      const frames = [before, ...await samples(6)];
      const result = inspectDock(name, frames, session, expectedHeights);
      if (Boolean(document.querySelector(".session-goal-island")) !== capsule) {
        result.failures.push(capsule ? "goal capsule disappeared" : "goal capsule survived a cleared goal");
      }
      cases.push(result);
    };
    await republish("goal-republished-new-object", { ...chrome, goal: { ...goal } } as Snapshot, 1, true);
    await republish("goal-clock-only", { ...chrome, goal: { ...goal, timeUsedMs: 5_000, snapshotAt: Date.now() } } as Snapshot, 1, true);
    await republish("goal-cleared-once", { ...chrome, goal: null } as Snapshot, 2, false);
    return {
      failures: cases.flatMap((value) => value.failures.map((failure) => `${value.name}: ${failure}`)),
      cases,
    };
  } finally {
    delete (document as { visibilityState?: unknown }).visibilityState;
    flushSync(() => root.render(null));
    defaultSessionLaneStore.clear();
  }
}
