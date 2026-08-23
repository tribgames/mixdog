import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test("a split-pane conversation portal fills its slot so the composer stays at the bottom", async () => {
  const css = await readFile(new URL("./pane-layout.css", import.meta.url), "utf8");
  const dom = new JSDOM(`
    <style>${css}</style>
    <div class="pane-conversation-slot">
      <div class="persistent-pane-surface conversation-persistent-surface">
        <div class="workspace"></div>
      </div>
    </div>
  `);
  const host = dom.window.document.querySelector(".conversation-persistent-surface");
  const workspace = dom.window.document.querySelector(".workspace");

  assert.ok(host);
  assert.ok(workspace);
  const rules = [...dom.window.document.styleSheets[0].cssRules];
  const ruleFor = (selector) => rules.find((rule) => rule.selectorText === selector);
  const hostRule = ruleFor(".pane-conversation-slot > .conversation-persistent-surface");
  assert.ok(hostRule);
  assert.equal(hostRule.style.position, "absolute");
  assert.equal(hostRule.style.inset, "0");
  assert.equal(hostRule.style.display, "flex");
  assert.equal(hostRule.style.flexDirection, "column");

  const workspaceRule = ruleFor(
    ".pane-conversation-slot > .conversation-persistent-surface > .workspace",
  );
  assert.ok(workspaceRule);
  assert.equal(workspaceRule.style.width, "100%");
  assert.equal(workspaceRule.style.height, "100%");
  assert.equal(workspaceRule.style.flex, "1 1 0%");
});
