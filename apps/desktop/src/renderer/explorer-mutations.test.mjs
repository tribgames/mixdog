// Explorer file-operation cover: which entries a copy/move is allowed to
// touch, how a batch reports partial failure, and the naming a nested "a/b/c"
// creation resolves to. Paste and drag-and-drop share this code, so the rules
// are pinned once here instead of twice through the pane.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  explorerCreatedEntry,
  explorerErrorText,
  explorerTransferRels,
  transferExplorerEntries,
  trashExplorerEntries,
} from "./explorer-mutations.ts";

const projectPath = "C:/demo";

test("a transfer skips itself, its own subtree and a move that changes nothing", () => {
  const rels = ["src", "src/app", "docs/readme.md", "notes.md"];
  assert.deepEqual(explorerTransferRels(rels, "src", false), ["docs/readme.md", "notes.md"]);
  // A copy into the folder an entry already lives in is a real duplicate.
  assert.deepEqual(explorerTransferRels(rels, "src", true), ["src/app", "docs/readme.md", "notes.md"]);
  assert.deepEqual(explorerTransferRels(["src"], "src/app", true), []);
  assert.deepEqual(explorerTransferRels(["notes.md"], "", false), []);
  assert.deepEqual(explorerTransferRels(["docs/readme.md"], "", false), ["docs/readme.md"]);
});

test("a transfer runs one entry at a time and reports the first failure", async () => {
  const calls = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const track = async (kind, rel) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await Promise.resolve();
    calls.push([kind, rel]);
    inFlight -= 1;
  };
  const api = {
    copyProjectEntry: async (_project, rel) => { await track("copy", rel); return { name: rel }; },
    moveProjectEntry: async (_project, rel) => {
      await track("move", rel);
      if (rel !== "ok.txt") throw new Error(`EBUSY: ${rel} is locked`);
    },
  };
  const copied = await transferExplorerEntries({
    api, projectPath, rels: ["a.txt", "b.txt"], targetDirRel: "docs", copy: true,
  });
  assert.deepEqual(copied.failed, []);
  assert.equal(copied.firstError, undefined);
  assert.deepEqual(calls, [["copy", "a.txt"], ["copy", "b.txt"]]);
  assert.equal(peakInFlight, 1);

  const moved = await transferExplorerEntries({
    api, projectPath, rels: ["first.txt", "ok.txt", "second.txt"], targetDirRel: "docs", copy: false,
  });
  assert.deepEqual(moved.failed, ["first.txt", "second.txt"]);
  assert.equal(explorerErrorText(moved.firstError), "EBUSY: first.txt is locked");
});

test("a delete attempts every entry and hands back only what survived", async () => {
  const attempted = [];
  const api = {
    trashProjectEntry: async (_project, rel) => {
      attempted.push(rel);
      if (rel === "locked.txt") throw new Error("EBUSY: locked.txt is in use");
    },
  };
  const result = await trashExplorerEntries({
    api, projectPath, rels: ["a.txt", "locked.txt", "b.txt"],
  });
  assert.deepEqual(attempted, ["a.txt", "locked.txt", "b.txt"]);
  assert.deepEqual(result.failed, ["locked.txt"]);
  assert.equal(explorerErrorText(result.firstError), "EBUSY: locked.txt is in use");
});

test("a host without the file bridge settles instead of throwing", async () => {
  const deleted = await trashExplorerEntries({ api: undefined, projectPath, rels: ["a.txt"] });
  assert.deepEqual(deleted, { failed: [], firstError: undefined });
  const moved = await transferExplorerEntries({
    api: {}, projectPath, rels: ["a.txt"], targetDirRel: "docs", copy: false,
  });
  assert.deepEqual(moved.failed, []);
});

test("nested creation reveals every folder it introduced", () => {
  assert.deepEqual(explorerCreatedEntry("src", "app/main.ts", false), {
    finalRel: "src/app/main.ts",
    expandRels: ["src/app"],
  });
  assert.deepEqual(explorerCreatedEntry("", "a/b", true), {
    finalRel: "a/b",
    expandRels: ["a", "a/b"],
  });
  assert.deepEqual(explorerCreatedEntry("", "notes.md", false), {
    finalRel: "notes.md",
    expandRels: [],
  });
  assert.deepEqual(explorerCreatedEntry("docs", "guide\\intro.md", false), {
    finalRel: "docs/guide/intro.md",
    expandRels: ["docs/guide"],
  });
});

test("failure text keeps the message the file bridge sent", () => {
  const message = "EPERM: operation not permitted, unlink 'C:/demo/a.txt'";
  assert.equal(explorerErrorText(new Error(message)), message);
  assert.equal(explorerErrorText("plain failure"), "plain failure");
});
