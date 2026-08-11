import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  listFolderDirAbs,
  windowsExplorerHiddenNames,
} from "./folder-explorer.ts";

const execFileAsync = promisify(execFile);

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
