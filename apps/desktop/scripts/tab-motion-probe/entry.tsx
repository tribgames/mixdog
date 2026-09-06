import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { WorkspaceTabStrip } from "../../src/renderer/WorkspaceTabStrip";
import type { WorkspaceTab } from "../../src/renderer/nav-types";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const idle = () => new Promise<void>((resolve) => setTimeout(resolve, 240));

async function exercise(width: number, initialCount: number, additions = 1) {
  const host = document.createElement("div");
  host.className = "pane-cell";
  Object.assign(host.style, { width: `${width}px`, display: "flex", flexDirection: "column" });
  document.body.append(host);
  const root = createRoot(host);
  let serial = 0;
  const makeTab = (): WorkspaceTab => {
    const draftId = String(++serial);
    return {
      key: `new:${draftId}`,
      title: `새 작업 ${draftId} — 긴 제목이 있는 탭 생성 애니메이션`,
      selection: { kind: "new", draftId },
    };
  };
  let tabs = Array.from({ length: initialCount }, makeTab);
  let activeKey = tabs.at(-1)!.key;
  const render = () => flushSync(() => root.render(
    <WorkspaceTabStrip tabs={tabs} activeKey={activeKey} focused
      trailing={<span style={{ width: 108 }} />}
      onSelectTab={(tab) => { activeKey = tab.key; render(); }}
      onCloseTab={() => {}} onReorderTab={() => {}}
      onNewTask={() => {
        const tab = makeTab();
        tabs = [...tabs, tab];
        activeKey = tab.key;
        render();
      }} />,
  ));
  try {
    render();
    await idle();
    const strip = host.querySelector<HTMLElement>(".workspace-tabs")!;
    if (!strip) throw new Error("The desktop tab strip did not mount");
    const sample = () => {
      const viewport = strip.getBoundingClientRect();
      const first = strip.firstElementChild!.getBoundingClientRect();
      const active = strip.querySelector<HTMLElement>('[data-active="true"]')!.getBoundingClientRect();
      return {
        scroll: strip.scrollLeft,
        firstOffset: first.left - viewport.left,
        activeWidth: active.width,
        activeVisible: active.left >= viewport.left - 1 && active.right <= viewport.right + 1,
      };
    };
    const samples = [];
    for (let index = 0; index < additions; index += 1) {
      host.querySelector<HTMLButtonElement>(".workspace-tab-new")!.click();
      samples.push(sample());
      // Interrupt a still-running entry motion rather than waiting for it.
      await frame();
      samples.push(sample());
      await frame();
    }
    const until = performance.now() + 240;
    while (performance.now() < until) {
      await frame();
      samples.push(sample());
    }
    const settled = sample();
    // Real overflow must still reveal either end, then return to a stationary
    // origin when a wider pane makes every tab fit again.
    activeKey = tabs[0].key;
    render();
    await idle();
    const selectedFirst = sample();
    activeKey = tabs.at(-1)!.key;
    render();
    await idle();
    const selectedLast = sample();
    host.style.width = "1280px";
    await idle();
    const expanded = sample();
    return { width, initialCount, additions, samples, settled, selectedFirst, selectedLast, expanded };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
}

Object.assign(window, {
  runTabMotionProbe: async () => {
    const results = [];
    for (const [width, count, additions] of [
      [960, 2, 1],
      [470, 2, 1],
      [320, 4, 1],
      [640, 3, 5],
      [439.5, 3, 1],
      [320, 12, 1],
    ]) {
      results.push(await exercise(width, count, additions));
    }
    return results;
  },
});
