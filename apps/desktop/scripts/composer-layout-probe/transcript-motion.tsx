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
  (window as any).mixdogDesktop = {
    rendererDiagnostic: noop,
    perfLog: noop,
    invokeCapability: async () => ({ value: null }),
  };
  const cases: ReturnType<typeof inspect>[] = [];
  let width = 620;
  let session = "";
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
        onOpenCommandSurface={noop} reviewActive={false} />
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
    return {
      failures: cases.flatMap((value) => value.failures.map((failure) => `${value.name}: ${failure}`)),
      cases,
    };
  } finally {
    flushSync(() => root.render(null));
    defaultSessionLaneStore.clear();
  }
}
