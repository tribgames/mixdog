import assert from "node:assert/strict";
import test from "node:test";
import {
  markdownAstCacheChars,
  rememberMarkdownAstWeight,
  MARKDOWN_AST_CACHE_MAX_CHARACTERS as LIMIT,
} from "./markdown-ast-weight.ts";
import { estimateRetainedChars } from "./renderer-value-weight.ts";
import { MarkdownWorkerHost } from "./markdown-worker-host.ts";

test("missing or malformed worker weights preserve bounded fallback accounting", () => {
  for (const invalid of [undefined, NaN, Infinity, -1, "10"]) {
    const root = { type: "root", children: [{ type: "text", value: "response" }] };
    rememberMarkdownAstWeight(root, invalid);
    assert.equal(markdownAstCacheChars(root, "source"),
      estimateRetainedChars(root, LIMIT) + "source".length);
  }
  const large = { type: "root", children: [{ type: "text", value: "x".repeat(LIMIT * 2) }] };
  assert.ok(markdownAstCacheChars(large, "") > LIMIT);
});

test("the real parser worker carries an accurate weight through the host reply", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "self");
  const handlers = new Map();
  let response;
  const scope = {
    onmessage: null,
    postMessage(value) {
      response = value;
      handlers.get("message")({ data: value });
    },
  };
  Object.defineProperty(globalThis, "self", { configurable: true, value: scope });
  const host = new MarkdownWorkerHost(() => ({
    addEventListener: (name, handler) => handlers.set(name, handler),
    postMessage: (value) => scope.onmessage({ data: value }),
    terminate() {},
  }));
  try {
    await import("./markdown-parser.worker.ts");
    for (const text of ["**hello**", "```js\nconst answer = 42;\n```", "| a | b |\n|---|---|\n| one | two |"]) {
      const root = await host.parse(text);
      assert.equal(response.retainedChars, estimateRetainedChars(root, LIMIT));
      assert.equal(markdownAstCacheChars(root, text), response.retainedChars + text.length);
      assert.ok(root.children.length > 0);
    }
  } finally {
    host.reclaim();
    if (previous) Object.defineProperty(globalThis, "self", previous);
    else delete globalThis.self;
  }
});
