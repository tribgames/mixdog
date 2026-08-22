// Explorer name grammar regression cover: the rules the pane's rename, "New
// file/folder" and paste paths depend on. Every case pins the PLATFORM flag
// explicitly so the suite reads the same on Windows and on CI Linux.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareExplorerNames,
  explorerPasteName,
  explorerTypeAheadIndex,
  isValidExplorerBasename,
  sortExplorerEntries,
  validateExplorerName,
  wellFormedExplorerName,
} from "./explorer-logic.ts";

test("well-formed names drop wrapping tabs and trailing separators", () => {
  assert.equal(wellFormedExplorerName("\treport.txt\t"), "report.txt");
  assert.equal(wellFormedExplorerName("notes/"), "notes");
  assert.equal(wellFormedExplorerName("notes\\"), "notes");
  assert.equal(wellFormedExplorerName(""), "");
});

test("basename validity follows the platform rule set", () => {
  assert.equal(isValidExplorerBasename("report.txt", true), true);
  assert.equal(isValidExplorerBasename("a:b", true), false);
  assert.equal(isValidExplorerBasename("a:b", false), true);
  assert.equal(isValidExplorerBasename("CON", true), false);
  assert.equal(isValidExplorerBasename("CON", false), true);
  assert.equal(isValidExplorerBasename("trailing.", true), false);
  assert.equal(isValidExplorerBasename(" padded ", true), false);
  assert.equal(isValidExplorerBasename("..", true), false);
  assert.equal(isValidExplorerBasename("x".repeat(256), true), false);
  assert.equal(isValidExplorerBasename("", true), false);
});

test("name validation reports one Explorer failure per rule", () => {
  const siblings = ["report.txt", "notes"];
  assert.equal(
    validateExplorerName({ name: "fresh.txt", siblings, windows: true }),
    null,
  );
  assert.equal(
    validateExplorerName({ name: "   ", siblings, windows: true })?.severity,
    "error",
  );
  assert.match(
    validateExplorerName({ name: "/rooted", siblings, windows: true })?.content ?? "",
    /cannot start with a slash/,
  );
  assert.match(
    validateExplorerName({ name: "a/b", siblings, windows: true })?.content ?? "",
    /must not contain path separators/,
  );
  assert.match(
    validateExplorerName({ name: "what?.txt", siblings, windows: true })?.content ?? "",
    /is not valid/,
  );
});

test("nested creation is allowed only where the caller opts in", () => {
  const siblings = ["notes"];
  assert.equal(
    validateExplorerName({ name: "a/b", siblings, allowSegments: true, windows: true }),
    null,
  );
  // A slashed name matches no child, so the duplicate guard stays out of it.
  assert.equal(
    validateExplorerName({ name: "notes/inner", siblings, allowSegments: true, windows: true }),
    null,
  );
});

test("duplicate names are refused case-insensitively unless renaming itself", () => {
  const siblings = ["report.txt", "notes"];
  assert.match(
    validateExplorerName({ name: "REPORT.TXT", siblings, windows: true })?.content ?? "",
    /already exists/,
  );
  assert.equal(
    validateExplorerName({
      name: "REPORT.TXT",
      originalName: "report.txt",
      siblings,
      windows: true,
    }),
    null,
  );
});

test("surrounding whitespace warns instead of blocking where it is legal", () => {
  assert.deepEqual(
    validateExplorerName({ name: " spaced.txt", siblings: [], windows: false }),
    {
      content: "Leading or trailing whitespace detected in file or folder name.",
      severity: "warning",
    },
  );
});

test("name order is numeric-aware and puts folders first", () => {
  assert.ok(compareExplorerNames("file2", "file10") < 0);
  assert.ok(compareExplorerNames("Alpha", "alpha") < 0);
  assert.equal(compareExplorerNames("same", "same"), 0);

  const entries = [
    { name: "b.txt", dir: false },
    { name: "A", dir: true },
    { name: "a.txt", dir: false },
    { name: "B", dir: true },
  ];
  assert.deepEqual(
    sortExplorerEntries(entries).map((entry) => entry.name),
    ["A", "B", "a.txt", "b.txt"],
  );
  assert.equal(entries[0].name, "b.txt");
});

test("type-ahead advances past the focused row and wraps", () => {
  const names = ["alpha", "beta", "bravo", "charlie"];
  assert.equal(explorerTypeAheadIndex(names, 0, "b"), 1);
  assert.equal(explorerTypeAheadIndex(names, 1, "b"), 2);
  assert.equal(explorerTypeAheadIndex(names, 3, "b"), 1);
  // A multi-character buffer may keep the row it is already sitting on.
  assert.equal(explorerTypeAheadIndex(names, 1, "be"), 1);
  assert.equal(explorerTypeAheadIndex(names, 0, "zz"), -1);
  assert.equal(explorerTypeAheadIndex(names, 0, ""), -1);
  assert.equal(explorerTypeAheadIndex([], 0, "a"), -1);
});

test("paste naming walks the Explorer copy sequence", () => {
  assert.equal(explorerPasteName("report.txt", false, new Set()), "report.txt");
  assert.equal(
    explorerPasteName("report.txt", false, new Set(["report.txt"])),
    "report copy.txt",
  );
  assert.equal(
    explorerPasteName("report.txt", false, new Set(["report.txt", "report copy.txt"])),
    "report copy 2.txt",
  );
  // A folder has no extension to preserve, even with a dot in its name.
  assert.equal(explorerPasteName("notes.v2", true, new Set(["notes.v2"])), "notes.v2 copy");
});
