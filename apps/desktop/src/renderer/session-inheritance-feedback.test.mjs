import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { CompletionStatus, ContextUsageIndicator } from "./transcript-status.tsx";
import { DESKTOP_TOAST_EVENT } from "./desktop-toasts.tsx";

test("inheritance completion renders a distinct, accessible conversation boundary", () => {
  const markup = renderToStaticMarkup(React.createElement(CompletionStatus, {
    item: { kind: "statusdone", status: "inherited" },
  }));
  const dom = new JSDOM(markup);
  try {
    const status = dom.window.document.querySelector('[role="status"]');
    assert.match(status.textContent, /Session inherited/);
    assert.match(status.textContent, /Continuing with the previous context/);
    assert.doesNotMatch(status.textContent, /compacted/i);
  } finally {
    dom.window.close();
  }
});

for (const outcome of ["success", "failure"]) {
  test(`inheritance stays visibly pending outside the context popover until ${outcome}`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
    const globals = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"];
    const previous = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    for (const key of globals) {
      Object.defineProperty(globalThis, key, {
        configurable: true, writable: true,
        value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[key],
      });
    }
    const root = createRoot(document.getElementById("root"));
    const notices = [];
    window.addEventListener(DESKTOP_TOAST_EVENT, (event) => notices.push(event.detail));
    let resolve;
    let reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const snapshot = {
      sessionId: "source",
      provider: "openai-oauth", model: "gpt-6-astra",
      items: [{ kind: "assistant", provider: "anthropic-oauth", modelId: "claude-fable-5-1" }],
    };
    const render = (open, current = snapshot) => root.render(React.createElement(ContextUsageIndicator, {
      snapshot: current, open, onOpenChange() {}, onInherit: () => pending,
    }));
    try {
      await act(async () => render(true));
      const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "Inherit session");
      assert.ok(button);
      await act(async () => button.click());
      assert.equal(button.disabled, true);
      await act(async () => render(false));
      assert.match(document.querySelector('[role="status"]').textContent, /Inheriting/);
      await act(async () => {
        if (outcome === "success") resolve();
        else reject(new Error("Carry failed"));
      });
      assert.equal(document.querySelector('[role="status"]'), null);
      if (outcome === "success") {
        await act(async () => render(true, {
          ...snapshot, sessionId: "heir",
          items: [...snapshot.items, {
            kind: "statusdone", status: "inherited",
            provider: snapshot.provider, modelId: snapshot.model,
          }],
        }));
        assert.ok([...document.querySelectorAll("button")].some((node) => node.textContent === "Compact context"));
        assert.equal(notices.length, 0);
      } else {
        assert.equal(notices.at(-1).tone, "error");
        assert.match(notices.at(-1).text, /Carry failed/);
        await act(async () => render(true));
        assert.ok([...document.querySelectorAll("button")].some((node) =>
          node.textContent === "Inherit session" && !node.disabled));
      }
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
}
