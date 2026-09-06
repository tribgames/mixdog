import React, { useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { TranscriptList } from "../../src/renderer/TranscriptList";
import { TranscriptRow } from "../../src/renderer/transcript-row";
import { SurfaceActiveContext } from "../../src/renderer/surface-activity";
import type { TranscriptRowModel } from "../../src/renderer/transcript-rows";
import "../../src/renderer/styles.css";
import "../../src/renderer/desktop.css";

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const root = createRoot(document.getElementById("root")!);
const code = Array.from({ length: 80 }, (_, i) => `const value${i} = { name: "item", index: ${i} };`).join("\n");
const table = "| Name | Value |\n| --- | ---: |\n"
  + Array.from({ length: 30 }, (_, i) => `| row ${i} | ${i * 3} |`).join("\n");
const rows: TranscriptRowModel[] = Array.from({ length: 2000 }, (_, i) => ({
  _tag: "AssistantPart", key: `message-${i}`, turnKey: `turn-${i}`,
  item: { kind: "assistant", id: i,
    text: `## Response ${i}\n\n\`\`\`typescript\n${code}\n\`\`\`\n\n${table}\n\n![local fixture](./fixture.svg)\n` },
}));
const noop = () => {};
const gesture = () => true;
const report = { rows: rows.length, mountMs: 0, frameMs: [] as number[],
  inputToFrameMs: [] as number[], renderedRowsMax: 0, scrollSamples: [] as number[],
  codeBlocks: 0, tables: 0, decodedImages: 0, failures: [] as string[] };
function Harness() {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollToEndRef = useRef(noop);
  return <SurfaceActiveContext.Provider value={true}>
    <section className="conversation" style={{ width: 960, height: 700, display: "flex", flexDirection: "column" }}>
      <div className="transcript-shell" style={{ height: 600, minHeight: 0, flex: "1 1 auto" }}>
        <div className="transcript" ref={viewport} style={{ height: "100%", overflowY: "auto" }}>
        <div className="thread">
          <TranscriptList sessionKey="isolated-perf" rows={rows} viewport={viewport}
            content={content} shouldAnchorBottom={false} scrollToEndRef={scrollToEndRef}
            hasScrollGesture={gesture} onSelectionAutoScroll={noop}
            renderRow={row => "item" in row && row.item ? <TranscriptRow item={row.item} /> : null} />
        </div>
      </div></div>
      <div className="composer-region"><form className="composer" onSubmit={event => event.preventDefault()}>
        <textarea aria-label="Performance input" style={{ height: 70 }} onInput={() => {
          const started = performance.now();
          requestAnimationFrame(() => report.inputToFrameMs.push(performance.now() - started));
        }} />
      </form></div>
    </section>
  </SurfaceActiveContext.Provider>;
}
window.addEventListener("error", event => report.failures.push(String(event.error?.stack || event.message)));
window.addEventListener("unhandledrejection", event => report.failures.push(String(event.reason)));
const inspect = () => {
  report.renderedRowsMax = Math.max(report.renderedRowsMax, document.querySelectorAll(".transcript-virtual-row").length);
  report.codeBlocks = Math.max(report.codeBlocks, document.querySelectorAll("pre code").length);
  report.tables = Math.max(report.tables, document.querySelectorAll("table").length);
  report.decodedImages = Math.max(report.decodedImages,
    [...document.images].filter(image => image.complete && image.naturalWidth > 0).length);
};
(window as any).prepareProbe = async () => {
  const start = performance.now();
  flushSync(() => root.render(<Harness />));
  // Conversation publishes its first snapshot after the containing viewport
  // ref is attached. Reproduce that parent update for the isolated child.
  await frame();
  flushSync(() => root.render(<Harness />));
  for (let i = 0; i < 180; i++) {
    await frame();
    inspect();
    if (report.codeBlocks && report.tables && report.decodedImages) break;
  }
  report.mountMs = performance.now() - start;
  if (!report.codeBlocks || !report.tables || !report.decodedImages) {
    report.failures.push("Code, table or decoded image did not render");
  }
  document.querySelector("textarea")!.focus();
};
(window as any).scrollProbe = async (step: number) => {
  const viewport = document.querySelector<HTMLDivElement>(".transcript")!;
  const start = performance.now();
  viewport.scrollTop = step % 2 ? 0 : Math.min(viewport.scrollHeight - viewport.clientHeight, step * 1200);
  viewport.dispatchEvent(new Event("scroll"));
  await frame();
  report.frameMs.push(performance.now() - start);
  report.scrollSamples.push(viewport.scrollTop);
  inspect();
};
(window as any).finishProbe = async () => {
  await frame();
  if (report.renderedRowsMax === 0 || report.renderedRowsMax >= rows.length) {
    report.failures.push("Transcript virtualization did not produce a bounded, nonempty row set");
  }
  if (report.inputToFrameMs.length !== 30) report.failures.push("Input delivery count mismatch");
  if (!report.scrollSamples.some(value => value > 0)) report.failures.push("Viewport did not scroll");
  const viewport = document.querySelector<HTMLDivElement>(".transcript")!;
  const geometry = { width: viewport.clientWidth, height: viewport.clientHeight, scrollHeight: viewport.scrollHeight };
  root.unmount();
  return { ...report, geometry, input: "Native Chromium editing in an isolated textarea beside the production transcript",
    limits: "Offscreen Electron, synthetic history; not installed app or physical display/GPU latency" };
};
