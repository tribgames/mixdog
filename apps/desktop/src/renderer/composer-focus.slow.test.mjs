import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

// Run the production hooks in Chromium: synthetic DOM key events cannot prove
// that focusing during keydown keeps the browser's first native character.
test("composer focus waits for browser typing without changing native-shell focus", async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "tsx",
      contents: `
        import React, { useRef, useState } from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { useComposerFocus, usePaneTypingFocus } from "./use-composer-focus";

        function Composer({ focusRequest = 0, transitioning = false }) {
          const textarea = useRef(null);
          const [draft, setDraft] = useState("");
          useComposerFocus({ textarea, focusRequest, transitioning, paneActive: true });
          return <form className="composer">
            <textarea id="composer" ref={textarea} value={draft}
              onChange={event => setDraft(event.target.value)} />
            <output id="draft">{draft}</output>
          </form>;
        }
        function Harness({ leafId = "one", kind = "session", ...props }) {
          usePaneTypingFocus(leafId, kind);
          return <>
            <input id="search" type="search" />
            <input id="title" className="session-header-title-input" />
            <div id="editor" contentEditable suppressContentEditableWarning />
            <button id="tool" type="button">Tool</button>
            <div id="modal" role="dialog" aria-modal="true" aria-hidden="true"
              inert hidden><button id="dialog-button">Dialog</button></div>
            <section data-pane-id="one"><Composer {...props} /></section>
            <section data-pane-id="two">
              <form className="composer"><textarea id="other" /></form>
            </section>
            <section data-pane-id="studio">
              <div className="studio-root" data-surface-active="true">
                <textarea id="studio" />
              </div>
            </section>
          </>;
        }
        const root = createRoot(document.getElementById("root"));
        window.renderFocusFixture = async (props = {}) => {
          flushSync(() => root.render(<Harness {...props} />));
          await new Promise(resolve => setTimeout(resolve, 0));
        };
        window.unmountFocusFixture = () => flushSync(() => root.unmount());
      `,
    },
    bundle: true,
    write: false,
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    headless: true,
  });
  t.after(() => browser.close());
  const newPage = async ({ native = false, touch = false } = {}) => {
    const page = await browser.newPage();
    if (native) await page.setUserAgent(`${await browser.userAgent()} Electron/41.10.3`);
    await page.setViewport({ width: 1000, height: 720, hasTouch: touch, isMobile: touch });
    await page.setContent(`<!doctype html><html><head><meta name="viewport"
      content="width=device-width,initial-scale=1"><style>
      body { margin: 0; } #root { min-height: 2000px; }
      #editor { min-height: 24px; } section { margin-top: 60px; }
      </style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    return page;
  };
  const render = (page, props = {}) => page.evaluate(
    (next) => window.renderFocusFixture(next), props,
  );
  const activeId = (page) => page.evaluate(() => document.activeElement.id);
  const leaveInput = (page) => page.evaluate(() => document.activeElement.blur());

  await t.test("web mount, navigation requests, and settled transitions leave focus and scroll alone", async () => {
    for (const touch of [false, true]) {
      const page = await newPage({ touch });
      await render(page);
      assert.equal(await activeId(page), "");
      await page.focus("#search");
      await page.evaluate(() => window.scrollTo(0, 300));
      const before = await page.evaluate(() => [scrollX, scrollY]);
      await render(page, { focusRequest: 1 });
      await render(page, { focusRequest: 2, transitioning: true });
      await render(page, { focusRequest: 2, transitioning: false });
      assert.equal(await activeId(page), "search");
      assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), before);
      await leaveInput(page);
      await render(page, { focusRequest: 3, transitioning: true });
      await render(page, { focusRequest: 3, transitioning: false });
      assert.equal(await activeId(page), "");
      assert.deepEqual(await page.evaluate(() => [scrollX, scrollY]), before);
    }
  });

  await t.test("the first hardware character and a complete Korean composition reach the controlled draft", async () => {
    const page = await newPage();
    await render(page);
    await page.keyboard.type("a");
    assert.equal(await activeId(page), "composer");
    assert.equal(await page.$eval("#draft", (node) => node.textContent), "a");
    await page.$eval("#composer", (node) => node.setSelectionRange(0, node.value.length));
    await leaveInput(page);
    const cdp = await page.createCDPSession();
    try {
      // The platform IME starts with Process (229), then replaces its active
      // composition. Use Chromium's native IME pipeline, not fabricated input.
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: "Process", code: "KeyG",
        windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229,
      });
      assert.equal(await activeId(page), "composer");
      for (const text of ["ㅎ", "하", "한"]) {
        await cdp.send("Input.imeSetComposition", {
          text, selectionStart: text.length, selectionEnd: text.length,
        });
      }
      await cdp.send("Input.insertText", { text: "한" });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Process", code: "KeyG",
        windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229,
      });
      assert.equal(await page.$eval("#composer", (node) => node.value), "한");
      assert.equal(await page.$eval("#draft", (node) => node.textContent), "한");
    } finally {
      await cdp.detach();
    }
  });

  await t.test("search, title, rich-text fields, shortcuts, and visible dialogs keep their keyboard", async () => {
    const page = await newPage();
    await render(page);
    for (const id of ["search", "title", "editor"]) {
      await page.focus(`#${id}`);
      await page.keyboard.type("x");
      assert.equal(await activeId(page), id);
      assert.equal(await page.$eval("#composer", (node) => node.value), "");
    }
    await page.focus("#tool");
    for (const key of ["ArrowDown", "Escape"]) {
      await page.keyboard.press(key);
      assert.equal(await activeId(page), "tool");
    }
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    assert.equal(await activeId(page), "tool");
    await page.$eval("#modal", (node) => {
      node.inert = false;
      node.hidden = false;
      node.removeAttribute("aria-hidden");
    });
    await page.keyboard.type("m");
    assert.equal(await activeId(page), "tool");
    assert.equal(await page.$eval("#composer", (node) => node.value), "");
  });

  await t.test("typing follows only the active pane and leaves inactive surfaces alone", async () => {
    const page = await newPage();
    await render(page, { leafId: "two", focusRequest: 1 });
    await page.keyboard.type("b");
    assert.equal(await activeId(page), "other");
    assert.equal(await page.$eval("#other", (node) => node.value), "b");
    assert.equal(await page.$eval("#composer", (node) => node.value), "");
    await leaveInput(page);
    await render(page, { leafId: "studio", kind: "studio" });
    await page.keyboard.type("s");
    assert.equal(await page.$eval("#studio", (node) => node.value), "s");
    await leaveInput(page);
    await render(page, { kind: "file" });
    await page.keyboard.type("f");
    assert.equal(await activeId(page), "");
    await render(page);
    await page.$eval("[data-pane-id='one']", (node) => { node.inert = true; });
    await page.keyboard.type("i");
    assert.equal(await activeId(page), "");
    await page.evaluate(() => window.unmountFocusFixture());
    await page.keyboard.type("u");
    assert.equal(await activeId(page), "");
  });

  await t.test("a touch-first web page still accepts hardware typing and direct field taps", async () => {
    const page = await newPage({ touch: true });
    await render(page);
    assert.equal(await activeId(page), "");
    await page.keyboard.type("k");
    assert.equal(await page.$eval("#draft", (node) => node.textContent), "k");
    await leaveInput(page);
    await page.tap("#composer");
    assert.equal(await activeId(page), "composer");
  });

  await t.test("native non-touch startup and navigation retain automatic focus", async () => {
    const page = await newPage({ native: true });
    await render(page);
    assert.equal(await activeId(page), "composer");
    await page.focus("#tool");
    await render(page, { focusRequest: 1 });
    assert.equal(await activeId(page), "composer");
    await page.focus("#tool");
    await render(page, { focusRequest: 1, transitioning: true });
    assert.equal(await activeId(page), "tool");
    await render(page, { focusRequest: 1, transitioning: false });
    assert.equal(await activeId(page), "composer");
    await page.focus("#title");
    await render(page, { focusRequest: 2 });
    assert.equal(await activeId(page), "title");
  });

  await t.test("window re-entry restores only native non-touch composer focus", async () => {
    for (const options of [{ native: true }, { native: false }, { native: false, touch: true }]) {
      const page = await newPage(options);
      await render(page);
      await leaveInput(page);
      await page.evaluate(async () => {
        window.dispatchEvent(new Event("focus"));
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      assert.equal(await activeId(page), options.native ? "composer" : "");
    }
  });
});
