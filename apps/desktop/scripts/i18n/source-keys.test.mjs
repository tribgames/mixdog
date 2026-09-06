import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectUiKeys, catalogProblems } from "./source-keys.mjs";

test("UI extraction covers TS data, variable phrases, JSX, and direct translations", () => {
  const directory = mkdtempSync(join(tmpdir(), "mixdog-i18n-"));
  try {
    writeFileSync(join(directory, "commands.ts"),
      `export const commands = [{ description: "Start a fresh chat", desktopDescription: "Close this task" }];
       const UI_EVENT = "mixdog:internal-event";`);
    writeFileSync(join(directory, "screen.tsx"),
      'const summaryPlaceholder = "Summary (required)"; const title = `Commit ${count} files`;\n'
      + 'const content = <><input placeholder={summaryPlaceholder}/><b>History</b>{t("Explicit label")}</>;');
    const found = collectUiKeys(directory);
    for (const key of ["Start a fresh chat", "Close this task", "Summary (required)", "Commit {{value0}} files", "History", "Explicit label"]) {
      assert.ok(found.has(key), key);
    }
    assert.equal(found.has("mixdog:internal-event"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("catalog validation rejects missing entries and damaged interpolation", () => {
  const problems = catalogProblems({
    "Hello {{name}}": "안녕하세요",
    "Ready": "",
    "undefined": "wrong positional mapping",
  }, ["Hello {{name}}", "Ready", "Missing"]);
  assert.deepEqual(problems.map(({ reason }) => reason),
    ["interpolation mismatch", "missing or empty", "missing or empty", "invalid key"]);
  assert.deepEqual(catalogProblems({ "Hello {{name}}": "{{name}}님 안녕하세요" }, ["Hello {{name}}"]), []);
});
