// Explorer tree-shape cover: the pure directory-map transitions the Files pane
// runs on every listing, refresh and auto-reveal. The rules pinned here are the
// ones a rendered tree cannot show directly — which map identity survives a
// no-op, and which directory a reveal touches next.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collapseExplorerDirs,
  explorerAbsolutePath,
  explorerChildRel,
  explorerHasExpandedDirs,
  explorerParentRel,
  explorerRefreshTargets,
  explorerRevealStep,
  explorerVisibleRows,
  patchExplorerDir,
  withChangedExplorerDirEntries,
  withExplorerDirEntries,
} from "./explorer-tree-model.ts";

const folder = (name) => ({ name, dir: true });
const file = (name) => ({ name, dir: false });

test("path grammar keeps the project root separator-free", () => {
  assert.equal(explorerParentRel("src/app/main.ts"), "src/app");
  assert.equal(explorerParentRel("notes.md"), "");
  assert.equal(explorerChildRel("", "src"), "src");
  assert.equal(explorerChildRel("src", "app"), "src/app");
  assert.equal(explorerAbsolutePath("C:/demo", "src/app.ts"), "C:/demo/src/app.ts");
  assert.equal(explorerAbsolutePath("C:/demo/", "a.txt"), "C:/demo/a.txt");
});

test("visible rows list directories first and descend only into expanded ones", () => {
  const dirs = new Map([
    ["", { expanded: true, entries: [file("b.txt"), folder("src"), file("a10.txt"), file("a9.txt")] }],
    ["src", { expanded: true, entries: [file("main.ts")] }],
  ]);
  assert.deepEqual(
    explorerVisibleRows(dirs).map((row) => [row.rel, row.level, row.expanded]),
    [["src", 0, true], ["src/main.ts", 1, false], ["a9.txt", 0, false], ["a10.txt", 0, false], ["b.txt", 0, false]],
  );
  const collapsed = new Map([...dirs, ["src", { expanded: false, entries: [file("main.ts")] }]]);
  assert.deepEqual(explorerVisibleRows(collapsed).map((row) => row.rel), ["src", "a9.txt", "a10.txt", "b.txt"]);
});

test("a failed directory contributes one error row instead of children", () => {
  const dirs = new Map([
    ["", { expanded: true, entries: [folder("src")] }],
    ["src", { expanded: true, entries: [file("main.ts")], error: "EACCES: permission denied" }],
  ]);
  const rows = explorerVisibleRows(dirs);
  assert.deepEqual(rows.map((row) => row.rel), ["src", "src\u0000error"]);
  assert.equal(rows[1].error, "EACCES: permission denied");
  assert.equal(rows[1].level, 1);
});

test("patching a directory never mutates the map it was given", () => {
  const listed = patchExplorerDir(new Map(), "src", { entries: [file("main.ts")] });
  assert.equal(listed.get("src").expanded, false);
  const expanded = patchExplorerDir(listed, "src", { expanded: true });
  assert.equal(expanded.get("src").expanded, true);
  assert.equal(expanded.get("src").entries.length, 1);
  assert.equal(listed.get("src").expanded, false);
});

test("a refresh replaces only the directories the tree still knows", () => {
  const dirs = new Map([
    ["", { expanded: true, entries: [folder("src")] }],
    ["src", { expanded: true, entries: [file("main.ts")] }],
  ]);
  const next = withExplorerDirEntries(dirs, [
    { rel: "", entries: [folder("src"), file("added.txt")] },
    { rel: "dropped", entries: [file("ghost.txt")] },
  ]);
  assert.deepEqual(next.get("").entries.map((entry) => entry.name), ["src", "added.txt"]);
  assert.equal(next.has("dropped"), false);
  assert.equal(next.get("src").entries.length, 1);
});

test("the watcher repaints only a listed directory whose contents changed", () => {
  const listed = new Map([["src", { expanded: true, entries: [file("main.ts")] }]]);
  assert.equal(withChangedExplorerDirEntries(listed, "src", [file("main.ts")]), listed);
  assert.equal(withChangedExplorerDirEntries(listed, "unknown", [file("main.ts")]), listed);
  const pending = new Map([["src", { expanded: true }]]);
  assert.equal(withChangedExplorerDirEntries(pending, "src", [file("main.ts")]), pending);
  const changed = withChangedExplorerDirEntries(listed, "src", [file("main.ts"), file("extra.ts")]);
  assert.notEqual(changed, listed);
  assert.equal(changed.get("src").entries.length, 2);
  assert.equal(changed.get("src").expanded, true);
});

test("refresh targets and collapse cover the root plus every expanded folder", () => {
  const dirs = new Map([
    ["", { expanded: true, entries: [] }],
    ["src", { expanded: true, entries: [] }],
    ["docs", { expanded: false, entries: [] }],
  ]);
  assert.deepEqual(explorerRefreshTargets(dirs), ["", "src"]);
  assert.equal(explorerHasExpandedDirs(dirs), true);
  const collapsed = collapseExplorerDirs(dirs);
  assert.equal(collapsed.get("").expanded, true);
  assert.equal(collapsed.get("src").expanded, false);
  assert.equal(explorerHasExpandedDirs(collapsed), false);
  // Nothing left to fold: the same map comes back, so the pane skips a render.
  assert.equal(collapseExplorerDirs(collapsed), collapsed);
});

test("reveal walks one ancestor per step and abandons a failed branch", () => {
  const target = "src/app/main.ts";
  assert.deepEqual(explorerRevealStep(new Map(), target), { kind: "load", rel: "src" });
  assert.deepEqual(
    explorerRevealStep(new Map([["src", { expanded: true }]]), target),
    { kind: "pending" },
  );
  const listedSrc = new Map([["src", { expanded: true, entries: [folder("app")] }]]);
  assert.deepEqual(explorerRevealStep(listedSrc, target), { kind: "load", rel: "src/app" });
  assert.deepEqual(
    explorerRevealStep(new Map([...listedSrc, ["src/app", { expanded: false, entries: [file("main.ts")] }]]), target),
    { kind: "expand", rel: "src/app" },
  );
  assert.deepEqual(
    explorerRevealStep(new Map([...listedSrc, ["src/app", { expanded: true, entries: [file("main.ts")] }]]), target),
    { kind: "ready" },
  );
  assert.deepEqual(
    explorerRevealStep(new Map([["src", { expanded: true, entries: [], error: "EPERM" }]]), target),
    { kind: "blocked" },
  );
  assert.deepEqual(explorerRevealStep(new Map(), "notes.md"), { kind: "ready" });
});
