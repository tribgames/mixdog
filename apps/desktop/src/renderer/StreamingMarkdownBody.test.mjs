import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import StreamingMarkdownBody from "./StreamingMarkdownBody.tsx";
import { parseMarkdownToHast } from "./markdown-ast.ts";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  const previous = new Map(["window", "document", "navigator", "Worker", "IS_REACT_ACT_ENVIRONMENT"]
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: class MarkdownWorkerStub {
      listeners = new Map();
      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }
      postMessage({ id, text }) {
        queueMicrotask(() => {
          this.listeners.get("message")?.({ data: { id, root: parseMarkdownToHast(text) } });
        });
      }
      terminate() {}
    },
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    root: createRoot(document.getElementById("root")),
    close() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

async function waitForRichMarkdown() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (document.querySelector(".markdown-code:not(.markdown-code-fallback)")) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  assert.fail("streaming fenced code did not promote to rich Markdown");
}

test("an unfinished fenced script promotes while it is still streaming", async () => {
  const dom = installDom();
  const source = "```js\nconst value = 1;";
  const CopyControl = () => React.createElement("button", { type: "button" }, "Copy");
  try {
    await act(async () => {
      dom.root.render(React.createElement(StreamingMarkdownBody, {
        text: source,
        copyControl: CopyControl,
      }));
    });
    await waitForRichMarkdown();
    assert.equal(Boolean(document.querySelector(".markdown-code-fallback")), false);
    assert.equal(document.body.textContent.includes("```"), false);
    assert.match(document.body.textContent, /const value = 1;/);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});
