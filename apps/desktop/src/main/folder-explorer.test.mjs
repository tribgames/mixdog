import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  browsableFolderPath,
  copyFolderEntriesAbs,
  listFolderDirAbs,
  moveFolderEntriesAbs,
  renameFolderEntryAbs,
  windowsExplorerHiddenNames,
} from "./folder-explorer.ts";

const execFileAsync = promisify(execFile);

test("folder paths must already be absolute", () => {
  assert.throws(() => browsableFolderPath("relative/folder"), /must be absolute/);
  assert.equal(browsableFolderPath(resolve("absolute-folder")), resolve("absolute-folder"));
});

test("Windows Explorer visibility parser hides Hidden/System entries only", () => {
  const hidden = windowsExplorerHiddenNames([
    "    H                C:\\Users\\Default\\Hidden",
    "   S                 C:\\Users\\Default\\System",
    "   SH   I            C:\\Users\\Default\\Application Data",
    "     R               C:\\Users\\Default\\Visible Junction",
  ].join("\r\n"));

  assert.deepEqual(
    [...hidden].sort(),
    ["application data", "hidden", "system"],
  );
});

test("folder listing follows Windows default Hidden/System visibility", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-folder-list-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const visible = join(root, "Visible");
  const hidden = join(root, "Hidden");
  const system = join(root, "System");
  const visibleJunction = join(root, "Visible Junction");
  await Promise.all([mkdir(visible), mkdir(hidden), mkdir(system)]);
  await symlink(visible, visibleJunction, "junction");
  await Promise.all([
    execFileAsync("attrib.exe", ["+H", hidden]),
    execFileAsync("attrib.exe", ["+S", system]),
  ]);

  const rows = await listFolderDirAbs(root);
  assert.deepEqual(
    rows.map((row) => [row.name, row.dir]),
    [["Visible", true], ["Visible Junction", true]],
  );
});

test("ask move reports same-name sources before moving anything", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-folder-move-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const left = join(root, "left");
  const right = join(root, "right");
  const target = join(root, "target");
  await Promise.all([mkdir(left), mkdir(right), mkdir(target)]);
  const first = join(left, "same.txt");
  const second = join(right, "same.txt");
  await Promise.all([writeFile(first, "left"), writeFile(second, "right")]);

  const result = await moveFolderEntriesAbs([first, second], target, "ask");

  assert.deepEqual(result, { conflicts: ["same.txt"], moved: [] });
  assert.deepEqual(await readdir(target), []);
  assert.deepEqual(await Promise.all([readdir(left), readdir(right)]), [["same.txt"], ["same.txt"]]);
});

test("self-nesting is refused across Windows case differences", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-folder-nest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "Parent");
  const child = join(parent, "Child");
  await mkdir(child, { recursive: true });

  await assert.rejects(
    moveFolderEntriesAbs([parent], child.toLowerCase(), "ask"),
    /into itself/,
  );
  await assert.rejects(
    copyFolderEntriesAbs([parent], child.toLowerCase()),
    /into itself/,
  );
});

test("Windows rename permits case-only name changes", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-folder-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "case-name.txt");
  await writeFile(source, "content");

  await renameFolderEntryAbs(source, "CASE-NAME.txt");

  assert.deepEqual(await readdir(root), ["CASE-NAME.txt"]);
});
