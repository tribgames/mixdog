import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEditorModelText,
  resolveEditorBackup,
} from "./editor-file-loader.ts";

test("normalizes mixed line endings with Monaco's majority rule", () => {
  assert.equal(normalizeEditorModelText("a\r\nb\nc\r\nd"), "a\r\nb\r\nc\r\nd");
  assert.equal(normalizeEditorModelText("a\nb\r\nc\n"), "a\nb\nc\n");
  assert.equal(normalizeEditorModelText("plain"), "plain");
});

test("discards backups that contain no recoverable edits", () => {
  const disk = "saved\n";
  const redundant = resolveEditorBackup(disk, {
    content: disk,
    expectedContent: disk,
  });
  assert.equal(redundant.content, disk);
  assert.equal(redundant.recovery, null);
  assert.equal(redundant.discardBackup, true);
});

test("restores unsaved backup when the disk baseline is unchanged", () => {
  const resolved = resolveEditorBackup("saved\n", {
    content: "edited\n",
    expectedContent: "saved\n",
  });
  assert.equal(resolved.content, "edited\n");
  assert.equal(resolved.savedContent, "saved\n");
  assert.equal(resolved.recovery?.diskChanged, false);
  assert.equal(resolved.recovery?.restored, true);
});

test("holds a conflicting backup until the user chooses", () => {
  const resolved = resolveEditorBackup("changed on disk\n", {
    content: "unsaved edit\n",
    expectedContent: "old disk\n",
  });
  assert.equal(resolved.content, "changed on disk\n");
  assert.equal(resolved.savedContent, "changed on disk\n");
  assert.equal(resolved.recovery?.content, "unsaved edit\n");
  assert.equal(resolved.recovery?.diskChanged, true);
  assert.equal(resolved.recovery?.restored, false);
});
