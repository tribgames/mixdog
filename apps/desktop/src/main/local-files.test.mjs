import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  absoluteLocalPath,
  readLocalFileAbs,
  statLocalEntryAbs,
} from "./local-files.ts";

test("local paths must already be absolute", () => {
  assert.throws(() => absoluteLocalPath("relative/file"), /must be absolute/);
  assert.equal(absoluteLocalPath(resolve("absolute-file")), resolve("absolute-file"));
});

test("local files can be described and read for editor and attachment flows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mixdog-local-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "note.txt");
  await writeFile(file, "hello", "utf8");

  assert.deepEqual(await statLocalEntryAbs(file), {
    absolutePath: file,
    name: "note.txt",
    dir: false,
    size: 5,
  });
  assert.deepEqual(await readLocalFileAbs(file), {
    name: "note.txt",
    size: 5,
    mimeType: "text/plain",
    data: Buffer.from("hello").toString("base64"),
  });
});
