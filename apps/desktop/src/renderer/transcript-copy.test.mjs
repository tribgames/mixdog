import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://mixdog.test/" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement"]) {
  globalThis[name] = name === "window" ? dom.window : name === "document" ? dom.window.document : dom.window[name];
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { copyTextToClipboard } = await import("./text-format.ts");
const { CopyControl } = await import("./transcript-primitives.tsx");
const { t } = await import("./i18n");
const clipboard = (writeText) => Object.defineProperty(navigator, "clipboard", {
  configurable: true, value: writeText ? { writeText } : undefined,
});

async function mount(value = "**답변**\n\n```js\nconst x = 1;\n```") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (text) => act(async () => {
    root.render(React.createElement(CopyControl, { value: text, label: "Copy response", className: "response-copy" }));
  });
  await render(value);
  return {
    button: host.querySelector("button"), host, render,
    click: () => act(async () => host.querySelector("button").click()),
    cleanup: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

test("copy preserves Markdown, waits for success, and blocks duplicate presses", async () => {
  let finish;
  const writes = [];
  clipboard((value) => { writes.push(value); return new Promise((resolve) => { finish = resolve; }); });
  const value = "**한글 답변**\n\n```js\nconst x = 1;\n```";
  const view = await mount(value);
  try {
    await view.click();
    await view.click();
    assert.deepEqual(writes, [value]);
    assert.equal(view.button.hasAttribute("data-copied"), false);
    assert.equal(view.button.disabled, true);
    await act(async () => finish());
    assert.equal(view.button.dataset.copied, "true");
    assert.equal(view.button.disabled, false);
  } finally { await view.cleanup(); }
});

test("denied clipboard writes report failure without retrying and allow a new press", async () => {
  let calls = 0;
  clipboard(async () => { if (++calls === 1) throw new Error("denied"); });
  document.execCommand = () => assert.fail("must not replay a rejected write");
  const view = await mount();
  try {
    await view.click();
    assert.equal(view.button.dataset.tooltip, t("Copy failed"));
    assert.equal(view.host.querySelector('[role="status"]').textContent, t("Copy failed"));
    assert.equal(view.button.hasAttribute("data-copied"), false);
    await view.click();
    assert.equal(calls, 2);
    assert.equal(view.button.dataset.copied, "true");
  } finally { await view.cleanup(); }
});

test("old message completion cannot overwrite a newer copy result", async () => {
  let finishOld;
  clipboard((value) => value === "old"
    ? new Promise((resolve) => { finishOld = resolve; })
    : Promise.reject(new Error("denied")));
  const view = await mount("old");
  try {
    await view.click();
    await view.render("new");
    assert.equal(view.button.disabled, false);
    await view.click();
    await act(async () => finishOld());
    assert.equal(view.button.dataset.tooltip, t("Copy failed"));
    await view.render("");
    assert.equal(view.button.disabled, true);
    assert.equal(view.button.hasAttribute("data-copied"), false);
  } finally { await view.cleanup(); }
});

test("unmounting during a write does not schedule copied feedback", async () => {
  let finish;
  clipboard(() => new Promise((resolve) => { finish = resolve; }));
  const view = await mount();
  await view.click();
  await view.cleanup();
  const original = window.setTimeout;
  let timers = 0;
  window.setTimeout = () => { timers += 1; return 0; };
  try {
    await act(async () => finish());
    assert.equal(timers, 0);
  } finally { window.setTimeout = original; }
});

for (const outcome of ["success", "false", "throw"]) {
  test(`legacy copy ${outcome} restores focus and selection and removes its temporary field`, async () => {
    clipboard();
    const editor = document.createElement("textarea");
    editor.value = "draft message";
    document.body.append(editor);
    editor.focus();
    editor.setSelectionRange(2, 7, "backward");
    document.execCommand = (command) => {
      assert.equal(command, "copy");
      const temporary = document.body.lastElementChild;
      assert.equal(temporary.value, "copied text");
      temporary.focus();
      if (outcome === "throw") throw new Error("unavailable");
      return outcome === "success";
    };
    try {
      if (outcome === "success") await copyTextToClipboard("copied text");
      else await assert.rejects(copyTextToClipboard("copied text"));
      assert.equal(document.activeElement, editor);
      assert.equal(editor.selectionStart, 2);
      assert.equal(editor.selectionEnd, 7);
      assert.equal(editor.selectionDirection, "backward");
      assert.equal(document.querySelectorAll("textarea").length, 1);
    } finally { editor.remove(); }
  });
}
