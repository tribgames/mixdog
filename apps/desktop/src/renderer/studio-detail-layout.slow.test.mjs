import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The Studio detail lays itself out from the size of its own pane, so one
// harness renders it on every surface that pane reaches: desktop windows and
// split cells, phones in both orientations, and tablets. `top` stands in for
// the phone toolbar above the pane. Tablets take the phone layout only below
// 640px (shared/surface-class.ts); wider ones get the desktop layout.
const SURFACES = [
  { name: 'desktop window', width: 1280, height: 800, layout: 'rail' },
  { name: 'short desktop window', width: 1024, height: 600, layout: 'compact-rail' },
  { name: 'desktop just under the breakpoint', width: 880, height: 700, layout: 'stacked' },
  { name: 'desktop split cell', width: 640, height: 400, layout: 'compact-rail' },
  { name: 'narrow desktop pane', width: 520, height: 820, layout: 'stacked' },
  { name: 'phone 360', width: 360, height: 780, top: 56, mobile: true, layout: 'stacked' },
  { name: 'phone 390', width: 390, height: 844, top: 56, mobile: true, layout: 'stacked' },
  { name: 'phone 430', width: 430, height: 932, top: 56, mobile: true, layout: 'stacked' },
  { name: 'phone landscape', width: 844, height: 390, top: 52, mobile: true, layout: 'compact-rail' },
  { name: 'small phone landscape', width: 667, height: 375, top: 52, mobile: true, layout: 'compact-rail' },
  { name: 'tablet split view', width: 600, height: 1180, top: 56, mobile: true, layout: 'stacked' },
  { name: 'tablet portrait', width: 820, height: 1180, layout: 'stacked' },
  { name: 'tablet landscape', width: 1180, height: 820, layout: 'rail' },
];

const PROMPT =
  'Editorial fashion photograph of a tennis player crossing a beige court from a high angle, a bold black ' +
  'court line cutting diagonally through the frame, two white balls, generous negative space, white visor and ' +
  'pleated skirt, camel leather handbag, soft directional daylight, warm muted palette, subtle film grain, ' +
  'understated European magazine aesthetic.';

const HARNESS = `
  import { createRoot } from "react-dom/client";
  import { StudioDetailViewer } from "./studio-media-components";

  const root = createRoot(document.getElementById("root"));
  const still = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1152" height="1536"><rect width="100%" height="100%" fill="#7a8fb8"/></svg>'
  );
  const noop = () => {};
  window.renderDetail = ({ remote, promptOpen, prompt }) => {
    const asset = {
      id: "asset-1",
      kind: "image",
      lane: "gemini",
      model: "gemini-3.1-flash-image",
      prompt,
      options: { aspectRatio: "3:4", resolution: "2k", quality: "high" },
      mime: "image/png",
      bytes: 2516582,
      createdAt: Date.UTC(2026, 8, 28, 6, 27),
    };
    root.render(
      <div className="studio-root">
        <div className="studio-pane">
          <div className="studio-shell">
            <StudioDetailViewer
              asset={asset}
              assetUrl={() => still}
              canUseAsReference
              copied={false}
              localTransport={!remote}
              mediaForeground
              modelLabel="Gemini 3.1 Flash Image"
              previewUrl=""
              promptOpen={promptOpen}
              providerLabel="Gemini"
              thumbUrl=""
              onClose={noop}
              onCopyPrompt={noop}
              onNext={noop}
              onOpenAsset={noop}
              onOpenFolder={noop}
              onPrevious={noop}
              onRegenerate={noop}
              onRemove={noop}
              onReusePrompt={noop}
              onSave={noop}
              onTogglePrompt={noop}
              onUrlBroken={noop}
              onUseAsReference={noop}
            />
          </div>
        </div>
      </div>
    );
  };
`;

/** Runs in the page: boxes of the card, stage, rail, media and every control. */
function measureDetail() {
  const box = (node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  };
  const shown = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  /** Line boxes a label wraps into. */
  const lines = (node) => {
    const label = node.querySelector(':scope > span');
    if (!label?.firstChild) return 0;
    const range = document.createRange();
    range.selectNodeContents(label);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  };
  const detail = document.querySelector('.studio-detail');
  const actions = detail.querySelector('.studio-detail-actions');
  const body = detail.querySelector('.studio-detail-body');
  const tagList = detail.querySelector('.studio-detail-block dl');
  return {
    body: box(body),
    bodyOverflow: body.scrollHeight - body.clientHeight,
    tagRow: box(tagList),
    tags: [...tagList.children].map((row) => {
      const value = row.querySelector('dd');
      return {
        text: value.textContent,
        box: box(row),
        truncated: value.scrollWidth > value.clientWidth + 1,
      };
    }),
    card: box(detail.querySelector('.studio-detail-card')),
    stage: box(detail.querySelector('.studio-detail-stage')),
    side: box(detail.querySelector('.studio-detail-side')),
    image: box(detail.querySelector('.studio-detail-stage img')),
    compact: getComputedStyle(detail.querySelector('.studio-detail-more')).display !== 'none',
    actionsOverflow: actions.scrollWidth - actions.clientWidth,
    actionLabels: [...actions.querySelectorAll(':scope > button, .studio-detail-more > button')]
      .filter(shown)
      .map((node) => node.textContent.trim()),
    controls: [...detail.querySelectorAll('button:not(.studio-detail-media-open)')].filter(shown).map((node) => ({
      name: node.getAttribute('aria-label') || node.textContent.trim(),
      kind: node.closest('.studio-detail-actions')
        ? 'action'
        : node.matches('.studio-detail-nav, .studio-detail-stage-close')
          ? 'stage'
          : 'row',
      box: box(node),
      text: node.textContent.trim(),
      lines: lines(node),
      labelOverflow: [...node.querySelectorAll('span')].reduce(
        (most, span) => Math.max(most, span.scrollWidth - span.clientWidth),
        0
      ),
    })),
  };
}

const inside = (inner, outer) =>
  inner.left >= outer.left - 0.5 &&
  inner.top >= outer.top - 0.5 &&
  inner.right <= outer.right + 0.5 &&
  inner.bottom <= outer.bottom + 0.5;

test('Studio detail keeps media, rail and actions in frame on every surface size', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      bundle: true,
      write: false,
      outfile: 'studio-detail-layout.js',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./desktop.css";',
      },
      outfile: 'studio-detail-layout.css',
      bundle: true,
      write: false,
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    }),
  ]);
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Entry animations slide the rail in; measure the settled frame.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css'))) {
    await page.addStyleTag({ content: file.text });
  }
  await page.addStyleTag({
    content: '#root { position: fixed; inset: var(--harness-top, 0px) 0 0 0; display: flex; }',
  });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });

  for (const surface of SURFACES) {
    await page.setViewport({ width: surface.width, height: surface.height });
    await page.evaluate(({ mobile, top }) => {
      const root = document.documentElement;
      root.toggleAttribute('data-mixdog-mobile-tabs', Boolean(mobile));
      root.style.setProperty('--harness-top', `${top || 0}px`);
    }, surface);
    for (const promptOpen of [false, true]) {
      const label = `${surface.name} ${surface.width}x${surface.height}${promptOpen ? ', prompt open' : ''}`;
      await page.evaluate((state) => window.renderDetail(state), {
        remote: Boolean(surface.mobile),
        promptOpen,
        prompt: PROMPT,
      });
      await page.waitForFunction(() => {
        const image = document.querySelector('.studio-detail-stage img');
        return Boolean(image?.complete && image.naturalWidth > 0);
      });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const frame = await page.evaluate(measureDetail);

      assert.ok(frame.actionsOverflow <= 1, `action bar fits its row: ${label}`);
      assert.ok(inside(frame.image, frame.stage), `media stays on the stage: ${label}`);
      assert.ok(
        frame.actionLabels.includes(surface.mobile ? 'Save' : 'Open Folder'),
        `surface file action present: ${label}`
      );
      if (!promptOpen) {
        assert.ok(frame.bodyOverflow <= 1, `collapsed details fit above the actions: ${label}`);
      }
      for (const tag of frame.tags) {
        assert.ok(
          tag.box.left >= frame.tagRow.left - 0.5 && tag.box.right <= frame.tagRow.right + 0.5,
          `tag "${tag.text}" stays within its row: ${label}`
        );
        assert.equal(tag.truncated, false, `tag "${tag.text}" shows its whole value: ${label}`);
        if (!promptOpen) {
          assert.ok(inside(tag.box, frame.body), `tag "${tag.text}" is in view without scrolling: ${label}`);
        }
      }
      for (const control of frame.controls) {
        assert.ok(inside(control.box, frame.card), `${control.name} stays inside the card: ${label}`);
        assert.ok(control.labelOverflow <= 1, `${control.name} label fits its slot: ${label}`);
        if (control.kind === 'action' && !/\s/.test(control.text)) {
          assert.equal(control.lines, 1, `single-word label "${control.text}" stays whole: ${label}`);
        }
        if (!surface.mobile) continue;
        const floor = (control.kind === 'row' ? 36 : 44) - 0.5;
        assert.ok(control.box.height >= floor, `${control.name} is ${control.box.height}px tall: ${label}`);
        if (control.kind === 'stage') {
          assert.ok(control.box.width >= floor, `${control.name} is ${control.box.width}px wide: ${label}`);
        }
      }
      if (surface.layout === 'rail') {
        assert.equal(frame.compact, false, `wide rail lists its actions: ${label}`);
        assert.ok(Math.abs(frame.side.width - 320) <= 1, `rail width ${frame.side.width}: ${label}`);
        assert.ok(frame.side.left >= frame.stage.right - 1, `rail beside the stage: ${label}`);
      } else if (surface.layout === 'compact-rail') {
        assert.equal(frame.compact, true, `compact action bar: ${label}`);
        assert.ok(frame.side.left >= frame.stage.right - 1, `rail beside the stage: ${label}`);
        assert.ok(frame.stage.height >= frame.card.height - 1, `stage keeps the full height: ${label}`);
        assert.ok(frame.stage.width >= frame.card.width * 0.5, `stage keeps half the width: ${label}`);
      } else if (surface.layout === 'stacked') {
        assert.equal(frame.compact, true, `compact action bar: ${label}`);
        assert.ok(frame.side.top >= frame.stage.bottom - 1, `sheet under the stage: ${label}`);
        const share = promptOpen ? 0.35 : 0.6;
        assert.ok(
          frame.stage.height >= frame.card.height * share,
          `stage keeps ${frame.stage.height}/${frame.card.height}px: ${label}`
        );
      }
    }
  }
  assert.deepEqual(errors, [], 'no renderer errors');
});
