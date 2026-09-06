import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ComposerPalette } from "../../src/renderer/ComposerPalette";
import { SurfaceActiveContext } from "../../src/renderer/surface-activity";
import { TranscriptList } from "../../src/renderer/TranscriptList";
import type { TranscriptRowModel } from "../../src/renderer/transcript-rows";
import { runConversationSubmitProbe } from "./submit";

const root = createRoot(document.getElementById("root")!);
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
const settle = async () => { for (let n = 0; n < 8; n++) await frame(); };
const failures: string[] = [];
const check = (value: unknown, label: string) => { if (!value) failures.push(label); };
let send = () => {};
let togglePalette = (_open: boolean) => {};
let toggleActive = (_active: boolean) => {};
let selections = 0;
const noop = () => {};
const noGesture = () => false;
function Harness({ count, chromeHeight, promptHeight }: {
  count: number; chromeHeight: number; promptHeight: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollToEndRef = useRef(noop);
  const anchor = useRef<HTMLFormElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(true);
  send = () => setSent(true);
  togglePalette = setOpen;
  toggleActive = setActive;
  const rows: TranscriptRowModel[] = Array.from({ length: count }, (_, index) => ({
    _tag: "UserMessage", key: `row-${index}`, turnKey: "old",
    item: { kind: "user", text: `History ${index}` }, attachedUser: false,
  }));
  if (sent) rows.push(
    { _tag: "TurnGap", key: "gap", turnKey: "new" },
    { _tag: "UserMessage", key: "prompt", turnKey: "new",
      item: { kind: "user", text: "New prompt" }, attachedUser: false },
    { _tag: "Thinking", key: "thinking", turnKey: "new", active: true },
  );
  return <SurfaceActiveContext.Provider value={active}>
    <section className="conversation" style={{ height: 620, width: 620, display: "flex", flexDirection: "column", margin: 30 }}>
      <div className="transcript-shell">
        <div className="transcript" ref={viewport}>
          <div className="thread">
            <TranscriptList sessionKey={`probe-${count}-${chromeHeight}-${promptHeight}`}
              rows={rows} viewport={viewport} content={content}
              shouldAnchorBottom scrollToEndRef={scrollToEndRef}
              hasScrollGesture={noGesture} onSelectionAutoScroll={noop}
              renderRow={(row) => <div data-probe-row={row.key}
                style={{ height: row.key === "prompt" ? promptHeight : row._tag === "TurnGap" ? 20 : 40 }}>
                {row.key}
              </div>} />
          </div>
        </div>
      </div>
      <div className="composer-region">
        {!sent && <div className="turn-review-slot" style={{ height: chromeHeight, background: "#a22" }}>Diff / goal</div>}
        <form ref={anchor} className="composer" style={{ height: 90 }}>
          <textarea aria-label="Probe input" defaultValue="/" />
          {open && <ComposerPalette anchor={anchor} panel={panel} id="probe-palette" label="Commands">
            {Array.from({ length: 10 }, (_, index) => <button type="button" role="option" key={index}
              onMouseDown={(event) => event.preventDefault()} onClick={() => { selections++; }}>
              Command {index}
            </button>)}
          </ComposerPalette>}
        </form>
      </div>
    </section>
  </SurfaceActiveContext.Provider>;
}
function geometry() {
  const viewport = document.querySelector<HTMLElement>(".transcript")!;
  const prompt = document.querySelector<HTMLElement>('[data-probe-row="prompt"]');
  const thinking = document.querySelector<HTMLElement>('[data-probe-row="thinking"]');
  return {
    diff: Boolean(document.querySelector(".turn-review-slot")),
    viewport: Math.round(viewport.getBoundingClientRect().bottom),
    prompt: prompt ? Math.round(prompt.getBoundingClientRect().top) : null,
    tail: thinking ? Math.round(thinking.getBoundingClientRect().bottom) : null,
    bottomGap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
  };
}
(window as any).runComposerLayoutProbe = async (mode = "all") => {
  if (mode === "submit") return runConversationSubmitProbe(root);
  const transitions = [];
  for (const scenario of [
    { count: 3, chromeHeight: 36, promptHeight: 40 },
    { count: 80, chromeHeight: 36, promptHeight: 40 },
    { count: 80, chromeHeight: 280, promptHeight: 140 },
    { count: 80, chromeHeight: 280, promptHeight: 500 },
  ]) {
    flushSync(() => root.render(<Harness key={JSON.stringify(scenario)} {...scenario} />));
    await settle();
    flushSync(send);
    // Microtasks belong to the commit, not a later painted frame.
    await Promise.resolve();
    const frames = [geometry()];
    for (let n = 0; n < 8; n++) { await frame(); frames.push(geometry()); }
    transitions.push({ scenario, frames });
    const first = frames[0];
    check(first.prompt !== null && !first.diff, `prompt and diff commit together ${JSON.stringify(scenario)}`);
    check(frames.every((item) => Math.abs((item.prompt ?? -1) - (first.prompt ?? -1)) <= 1
      && Math.abs((item.tail ?? -1) - (first.tail ?? -1)) <= 1
      && item.viewport === first.viewport), `no second submit jump ${JSON.stringify(scenario)}`);
  }
  flushSync(() => root.render(<Harness key="palette" count={3} chromeHeight={280} promptHeight={40} />));
  await settle();
  const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
  input.focus();
  flushSync(() => togglePalette(true));
  await settle();
  const menu = document.getElementById("probe-palette")!;
  const box = menu.getBoundingClientRect();
  const anchor = document.querySelector(".composer")!.getBoundingClientRect();
  check(Math.abs(box.bottom - (anchor.top - 8)) <= 1, "palette follows input upper edge");
  check(Math.abs(box.width - anchor.width) <= 1, "palette matches input width");
  check(box.top >= 8, "palette is clamped inside viewport");
  check(menu.contains(document.elementFromPoint(box.left + 12, box.bottom - 12)), "palette hit wins over diff");
  const option = menu.querySelector("button")!;
  option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  option.click();
  check(selections === 1 && document.activeElement === input, "palette selects once and keeps typing focus");
  const form = document.querySelector<HTMLFormElement>(".composer")!;
  form.style.height = "150px";
  await settle();
  check(Math.abs(menu.getBoundingClientRect().bottom - (form.getBoundingClientRect().top - 8)) <= 1,
    "palette follows input resize");
  flushSync(() => toggleActive(false));
  check(!document.getElementById("probe-palette"), "inactive surface has no orphan popup");
  flushSync(() => root.render(null));
  const submit = mode === "all" ? await runConversationSubmitProbe(root) : null;
  return { failures: [...failures, ...(submit?.failures || [])], transitions, submit };
};
