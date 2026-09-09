import React from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { Conversation } from "../../src/renderer/Conversation";
import { SessionGoalIsland } from "../../src/renderer/SessionGoalIsland";
import { preloadMarkdownBody } from "../../src/renderer/markdown-body-loader";

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
const noop = () => {};
export async function runConversationSubmitProbe(root: Root) {
  await preloadMarkdownBody();
  const cases = [];
  for (const chrome of ["diff-goal", "goal", "diff"] as const) {
    for (const multiline of [false, true]) {
      for (const expanded of [false, true]) {
        cases.push(await runSubmitCase(root, chrome, multiline, expanded));
      }
    }
  }
  return {
    failures: cases.flatMap((result) => result.failures.map((failure) => `${result.name}: ${failure}`)),
    cases,
  };
}

async function runSubmitCase(root: Root, chrome: "diff-goal" | "goal" | "diff", multiline: boolean, expanded: boolean) {
  const name = `${chrome}-${multiline ? "multiline" : "single"}-${expanded ? "expanded" : "collapsed"}`;
  const hasDiff = chrome !== "goal";
  const hasGoal = chrome !== "diff";
  const prompt = multiline ? "Probe next prompt\nSecond line\nThird line\nFourth line" : "Probe next prompt";
  const failures: string[] = [];
  const frames: unknown[] = [];
  const patch = "diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-before\n+after";
  let reviewCheckpoint = "previous-prompt";
  (window as any).mixdogDesktop = {
    rendererDiagnostic: noop,
    perfLog: noop,
    invokeCapability: async () => ({ value: {
      authoritative: true, checkpointId: reviewCheckpoint, snapshotKind: "worktree",
      files: hasDiff && reviewCheckpoint === "previous-prompt"
        ? [{ path: "demo.txt", status: "M", additions: 1, deletions: 1 }] : [],
      patch: hasDiff && reviewCheckpoint === "previous-prompt" ? patch : "", agents: [],
    } }),
  };
  const items = [
    ...Array.from({ length: 30 }, (_, i) => [
      { id: `history-${i}`, kind: "user", text: `History message ${i}` },
      { id: `response-${i}`, kind: "assistant",
        text: `## Response ${i}\n\n` + "A measured paragraph with wrapping in the previous conversation. ".repeat(4)
          + "\n\n```typescript\nconst previous = true;\nconst next = false;\n```" },
      { id: `done-${i}`, kind: "turndone", text: "Done" },
    ]).flat(),
    { id: "previous-prompt", kind: "user", text: "Previous work" },
    ...(hasDiff ? [{ id: "patch", kind: "tool", name: "apply_patch", args: {},
      result: "Updated demo.txt", uiDiff: patch }] : []),
    { id: "done", kind: "turndone", text: "Done" },
  ];
  const snapshot: any = {
    sessionId: `submit-probe-${name}`, currentProject: "C:/Project/demo",
    items, busy: false, commandBusy: false, model: "probe",
    goal: hasGoal ? { id: "goal", status: "complete", title: "Previous goal", tasks: [] } : null,
  };
  let acknowledge: ((value: boolean) => void) | undefined;
  const submit = () => new Promise<boolean>((done) => { acknowledge = done; });
  const render = () => root.render(<div style={{ height: 620, width: 620, margin: 30, display: "flex" }}>
    <Conversation snapshot={snapshot} routeSnapshot={snapshot} invokeResult={async (fn) => fn()}
      errors={[]} submit={submit} applySnapshot={noop} transitioning={false} composerFocusRequest={0}
      onNewTask={noop} onClearProject={noop} onResumeSession={noop} onOpenSessions={noop}
      onOpenProjects={noop} projects={[]} showProjectSelector={false}
      activeProjectPath="C:/Project/demo" activeProjectLabel="demo" onSelectProject={noop}
      onOpenCommandSurface={noop} reviewActive
      goalIsland={<SessionGoalIsland snapshot={snapshot} />} />
  </div>);
  flushSync(render);
  for (let n = 0; n < 12; n++) await frame();
  const input = document.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (!input) return { name, failures: ["real composer failed to mount"], frames };
  const measure = () => {
    const viewport = document.querySelector<HTMLElement>(".transcript")!;
    const row = [...document.querySelectorAll<HTMLElement>('[data-tag="UserMessage"]')]
      .find((node) => node.textContent?.includes("Probe next prompt"));
    return {
      shown: getComputedStyle(viewport).visibility !== "hidden",
      diff: Boolean(document.querySelector(".turn-review-bar")),
      goal: Boolean(document.querySelector(".session-goal-island")),
      prompt: row ? Math.round(row.getBoundingClientRect().top) : null,
      promptHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      viewport: Math.round(viewport.getBoundingClientRect().bottom),
      composer: Math.round(input.getBoundingClientRect().top),
      gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      rows: [...viewport.querySelectorAll<HTMLElement>(".transcript-virtual-row")].map((node) => {
        const box = node.getBoundingClientRect();
        const view = viewport.getBoundingClientRect();
        return { key: node.dataset.timelineKey!, top: box.top, position: node.style.top,
          visible: box.bottom > view.top && box.top < view.bottom };
      }),
    };
  };
  const before = measure();
  if (before.diff !== hasDiff || before.goal !== hasGoal) failures.push("fixture has incorrect completed chrome");
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "/");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await frame();
  const palette = document.getElementById("composer-slash-palette");
  if (!palette) failures.push("real slash palette did not open");
  else {
    const box = palette.getBoundingClientRect();
    if (!palette.contains(document.elementFromPoint(box.left + 12, box.bottom - 12))) {
      failures.push("real slash palette is covered by previous-turn chrome");
    }
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await frame();
    if (!palette.querySelector("#composer-slash-option-1[aria-selected='true']")) {
      failures.push("real slash keyboard selection did not advance");
    }
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await frame();
    if (document.getElementById("composer-slash-palette") || document.activeElement !== input) {
      failures.push("Escape failed to dismiss the palette while retaining input focus");
    }
  }
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, prompt);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await frame();
  if (expanded) {
    document.querySelector<HTMLButtonElement>(".turn-review-summary")?.click();
    document.querySelector<HTMLButtonElement>(".turn-review-file")?.click();
    document.querySelector<HTMLButtonElement>(".session-goal-trigger")?.click();
    for (let n = 0; n < 20; n++) await frame();
    input.focus({ preventScroll: true });
  }
  const viewport = document.querySelector<HTMLElement>(".transcript")!;
  const scrollWrites: { frame: number; top: number; gap: number }[] = [];
  const recordScroll = () => scrollWrites.push({
    frame: frames.length, top: viewport.scrollTop,
    gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
  });
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get() { return scrollTop.get!.call(this); },
    set(value) { scrollTop.set!.call(this, value); recordScroll(); },
  });
  const scrollTo = viewport.scrollTo.bind(viewport);
  viewport.scrollTo = (...args: any[]) => { (scrollTo as any)(...args); recordScroll(); };
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  // Capture every painted frame across the real keyboard/submission path,
  // then the host's independent transcript and goal publications.
  for (let n = 0; n < 8; n++) { await frame(); frames.push(measure()); }
  acknowledge?.(true);
  reviewCheckpoint = "host-next";
  for (let n = 0; n < 3; n++) { await frame(); frames.push(measure()); }
  snapshot.items = [...items, { id: "host-next", kind: "user", text: prompt }];
  snapshot.busy = true;
  flushSync(render);
  for (let n = 0; n < 3; n++) { await frame(); frames.push(measure()); }
  if (snapshot.goal) {
    snapshot.goal = { ...snapshot.goal, snapshotAt: Date.now(), timeUsedMs: 100 };
    flushSync(render);
    for (let n = 0; n < 3; n++) { await frame(); frames.push(measure()); }
  }
  snapshot.goal = null;
  flushSync(render);
  for (let n = 0; n < 3; n++) { await frame(); frames.push(measure()); }
  const committed = frames as ReturnType<typeof measure>[];
  const first = committed.findIndex((value) => value.shown && value.prompt !== null);
  if (first < 0) failures.push("submitted prompt did not become visible");
  if (first >= 0 && committed.slice(first).some((value) => value.diff || value.goal)) {
    failures.push("completed diff/goal removal and visible prompt are not atomic");
  }
  if (first >= 0 && committed.slice(first).some((value) =>
    value.prompt !== committed[first].prompt || value.viewport !== committed[first].viewport
      || value.composer !== committed[first].composer || Math.abs(value.gap) > 1)) {
    failures.push("real submit paints multiple prompt/viewport positions");
  }
  const finalRows = new Map(committed.at(-1)?.rows.map((row) => [row.key, row.top]));
  const maxDrift = Math.max(0, ...committed.slice(Math.max(0, first)).flatMap((value) =>
    value.rows.filter((row) => value.shown && row.visible && finalRows.has(row.key))
      .map((row) => Math.abs(row.top - finalRows.get(row.key)!))));
  if (maxDrift > 1) failures.push(`existing conversation moves after submit (${maxDrift.toFixed(1)}px)`);
  const movingRows = committed.flatMap((value, frame) => value.rows
    .filter((row) => value.shown && row.visible && finalRows.has(row.key) && Math.abs(row.top - finalRows.get(row.key)!) > 1)
    .map((row) => ({ frame, ...row, finalTop: finalRows.get(row.key) })));
  let direction = 0;
  for (let index = 1; index < scrollWrites.length; index++) {
    const previous = scrollWrites[index - 1];
    const current = scrollWrites[index];
    if (previous.frame !== current.frame) { direction = 0; continue; }
    const delta = current.top - previous.top;
    if (Math.abs(delta) < 1) continue;
    if (direction && Math.sign(delta) !== direction) {
      failures.push(`native scroll reverses within submitted frame ${current.frame}`);
      break;
    }
    direction = Math.sign(delta);
  }
  flushSync(() => root.render(null));
  return { name, failures, before, maxDrift, movingRows, scrollWrites, frames };
}
