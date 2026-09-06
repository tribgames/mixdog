import React from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { Conversation } from "../../src/renderer/Conversation";
import { SessionGoalIsland } from "../../src/renderer/SessionGoalIsland";

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
const noop = () => {};
export async function runConversationSubmitProbe(root: Root) {
  const cases = [];
  for (const chrome of ["diff-goal", "goal", "diff"] as const) {
    for (const multiline of [false, true]) {
      cases.push(await runSubmitCase(root, chrome, multiline));
    }
  }
  return {
    failures: cases.flatMap((result) => result.failures.map((failure) => `${result.name}: ${failure}`)),
    cases,
  };
}

async function runSubmitCase(root: Root, chrome: "diff-goal" | "goal" | "diff", multiline: boolean) {
  const name = `${chrome}-${multiline ? "multiline" : "single"}`;
  const hasDiff = chrome !== "goal";
  const hasGoal = chrome !== "diff";
  const prompt = multiline ? "Probe next prompt\nSecond line\nThird line\nFourth line" : "Probe next prompt";
  const failures: string[] = [];
  const frames: unknown[] = [];
  (window as any).mixdogDesktop = {
    rendererDiagnostic: noop,
    perfLog: noop,
    invokeCapability: async () => ({ value: null }),
  };
  const items = [
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `history-${i}`, kind: "user", text: `History message ${i}`,
    })),
    ...(hasDiff ? [{ id: "patch", kind: "tool", name: "apply_patch", args: {},
      result: "Updated demo.txt", uiDiff: "diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-before\n+after" }] : []),
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
      onOpenCommandSurface={noop} reviewActive={false}
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
      diff: Boolean(document.querySelector(".turn-review-bar")),
      goal: Boolean(document.querySelector(".session-goal-island")),
      prompt: row ? Math.round(row.getBoundingClientRect().top) : null,
      promptHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      viewport: Math.round(viewport.getBoundingClientRect().bottom),
      composer: Math.round(input.getBoundingClientRect().top),
      gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
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
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  // Capture every painted frame across the real keyboard/submission path,
  // then the host's independent transcript and goal publications.
  for (let n = 0; n < 8; n++) { await frame(); frames.push(measure()); }
  acknowledge?.(true);
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
  const first = committed.findIndex((value) => value.prompt !== null);
  if (first < 0) failures.push("submitted prompt did not become visible");
  if (first >= 0 && committed.slice(first).some((value) => value.diff || value.goal)) {
    failures.push("completed diff/goal removal and visible prompt are not atomic");
  }
  if (first >= 0 && committed.slice(first).some((value) =>
    value.prompt !== committed[first].prompt || value.viewport !== committed[first].viewport
      || value.composer !== committed[first].composer || Math.abs(value.gap) > 1)) {
    failures.push("real submit paints multiple prompt/viewport positions");
  }
  flushSync(() => root.render(null));
  return { name, failures, before, frames };
}
