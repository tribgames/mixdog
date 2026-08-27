/**
 * markdown-pipeline.test.mjs — desktop/web markdown element coverage.
 *
 * Pins the worker AST pipeline (parseMarkdownToHast) and the streaming source
 * fallback so the two never diverge from the terminal surfaces covered by
 * scripts/markdown-surface-test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import { parseMarkdownToHast } from "./markdown-ast";
import { MarkdownSourceFallback } from "./MarkdownSourceFallback";
import StreamingMarkdownBody from "./StreamingMarkdownBody";
import { createTranscriptRowMeasureScheduler } from "./transcript-measure";

function flatten(node) {
  if (node.type === "text") return JSON.stringify(node.value);
  const tag = node.tagName ? node.tagName : "";
  const children = (node.children ?? []).map(flatten).join(",");
  return tag ? `${tag}(${children})` : children;
}

function ast(source) {
  return parseMarkdownToHast(source).children.map(flatten).join("|");
}

test("strong closes against a punctuation + letter boundary", () => {
  assert.match(ast("**0.118%**tail"), /strong\("0\.118%"\)/);
});

test("strong containing inline code closes before a Korean suffix", () => {
  const rendered = ast("현재 Chrome은 **디시인사이드 `AI 활용 마이너 갤러리`**를 보고 있습니다.");
  assert.match(rendered, /strong\("디시인사이드 ",code\("AI 활용 마이너 갤러리"\)\)/);
  assert.match(rendered, /"를 보고 있습니다\."/);
});

test("strikethrough is pair-only", () => {
  assert.match(ast("~~gone~~ kept"), /del\("gone"\)/);
  assert.equal(ast("1~2 range").includes("del("), false);
});

test("task boxes become checkbox inputs", () => {
  const rendered = ast("- [ ] todo\n- [x] done");
  assert.match(rendered, /input\(\)/);
});

test("a bare <br> becomes a line break, other tags stay literal", () => {
  const cell = ast("| a |\n|---|\n| x<br>y |");
  assert.match(cell, /td\("x",br\(\)/);
  assert.equal(cell.includes('"<br>"'), false);
  assert.match(ast("one<br />two"), /br\(\)/);
  assert.match(ast("a <br class='x'> b"), /"<br class='x'>"/);
});

test("raw HTML stays literal but comments are dropped", () => {
  assert.match(ast("text <b>x</b> end"), /"<b>"/);
  assert.equal(ast("<!-- hidden -->").includes("hidden"), false);
});

test("source fallback adopts heading, list and emphasis grammar", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownSourceFallback, {
      text: "## Head\n\n- one\n- two\n\n*it* and ~~gone~~ and **strong**",
    }),
  );
  assert.match(markup, /<h2>Head<\/h2>/);
  assert.match(markup, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(markup, /<em>it<\/em>/);
  assert.match(markup, /<del>gone<\/del>/);
  assert.match(markup, /<strong>strong<\/strong>/);
});

test("source fallback keeps fenced code in its final card grammar", () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownSourceFallback, { text: "```js\nconst a = 1;\n```" }),
  );
  assert.match(markup, /markdown-code/);
  assert.match(markup, /const a = 1;/);
});

test("markdown chunk promotions coalesce into one transcript row measurement", async () => {
  let measurements = 0;
  const schedule = createTranscriptRowMeasureScheduler(() => {
    measurements += 1;
  });
  schedule();
  schedule();
  assert.equal(measurements, 0);
  await Promise.resolve();
  assert.equal(measurements, 1);
});

test("streaming markdown never exposes source while its first AST is pending", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  const previous = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"]
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(dom.window.document.getElementById("root"));
  const CopyControl = () => null;
  let measurements = 0;
  const onRendered = () => {
    measurements += 1;
  };
  try {
    await act(async () => {
      root.render(React.createElement(StreamingMarkdownBody, {
        text: "first line",
        parse: false,
        copyControl: CopyControl,
        onRendered,
      }));
    });
    assert.equal(dom.window.document.getElementById("root").innerHTML, "");
    assert.equal(measurements, 0);

    await act(async () => {
      root.render(React.createElement(StreamingMarkdownBody, {
        text: "first line\nsecond line",
        parse: false,
        copyControl: CopyControl,
        onRendered,
      }));
    });
    assert.equal(dom.window.document.getElementById("root").innerHTML, "");
    assert.equal(measurements, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("streaming fenced scripts keep final card geometry while their first AST is pending", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  const previous = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"]
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = dom.window.document.getElementById("root");
  const root = createRoot(host);
  const CopyControl = () => null;
  let measurements = 0;
  const onRendered = () => {
    measurements += 1;
  };
  try {
    await act(async () => {
      root.render(React.createElement(StreamingMarkdownBody, {
        text: "```ts",
        parse: false,
        copyControl: CopyControl,
        onRendered,
      }));
    });
    const openingFallback = host.querySelector(".markdown-code-fallback");
    assert.ok(openingFallback);
    assert.equal(openingFallback.querySelector("header span")?.textContent, "ts");
    assert.equal(openingFallback.querySelector("code")?.textContent, "");
    assert.equal(host.textContent.includes("```"), false);

    await act(async () => {
      root.render(React.createElement(StreamingMarkdownBody, {
        text: "```ts\nconst answer = 42;",
        parse: false,
        copyControl: CopyControl,
        onRendered,
      }));
    });
    assert.equal(host.querySelector(".markdown-code-fallback code")?.textContent,
      "const answer = 42;");
    assert.equal(measurements, 2);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
