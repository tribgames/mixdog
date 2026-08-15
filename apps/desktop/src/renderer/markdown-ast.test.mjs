import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdownToHast } from "./markdown-ast.ts";

function elements(node, tagName, found = []) {
  if (node?.type === "element" && node.tagName === tagName) found.push(node);
  for (const child of node?.children || []) elements(child, tagName, found);
  return found;
}

function text(node) {
  if (node?.type === "text") return String(node.value || "");
  return (node?.children || []).map(text).join("");
}

test("Korean suffixes do not expose strong markers after punctuation", () => {
  const root = parseMarkdownToHast(
    "`apiPercentUsed=0.118`은 **0.118%**이며, 양수를 **1%**로 표시합니다.",
  );
  assert.deepEqual(elements(root, "strong").map(text), ["0.118%", "1%"]);
  assert.equal(text(root), "apiPercentUsed=0.118은 0.118%이며, 양수를 1%로 표시합니다.");
});

test("ordinary CommonMark strong remains unchanged", () => {
  const root = parseMarkdownToHast("**일반 굵게**와 __두 번째__ 항목");
  assert.deepEqual(elements(root, "strong").map(text), ["일반 굵게", "두 번째"]);
});
