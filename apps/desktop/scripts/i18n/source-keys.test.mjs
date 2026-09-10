import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectUiKeys, catalogProblems, reusableTranslation } from "./source-keys.mjs";

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
    for (const key of ["Close this task", "Summary (required)", "Commit {{value0}} files", "History", "Explicit label"]) {
      assert.ok(found.has(key), key);
    }
    assert.equal(found.has("Start a fresh chat"), false, "the desktop override is the rendered description");
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

test("native and early UI extraction excludes diagnostics and retains exact translation keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "mixdog-i18n-native-"));
  try {
    writeFileSync(join(directory, "dialogs.ts"),
      'const options = { title: nativeT("Open files") }; const diagnostic = { message: "internal only" };\n'
      + 'tExisting("{{count}} entries", original, { count }); earlyUiT("Wait for approval"); t("  exact spacing  ");');
    const keys = collectUiKeys(directory, { explicitOnly: true });
    assert.deepEqual([...keys.keys()], ["Open files", "{{count}} entries", "Wait for approval", "  exact spacing  "]);
    assert.deepEqual([...collectUiKeys(directory, {
      explicitOnly: true, functions: ["earlyUiT"],
    }).keys()], ["Wait for approval"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("catalog validation accepts plural forms but checks their interpolation and rejects orphan forms", () => {
  assert.deepEqual(catalogProblems({
    "{{count}} files": "{{count}} fichiers",
    "{{count}} files_one": "{{count}} fichier",
  }, ["{{count}} files", "{{count}} files_one"]), []);
  const broken = catalogProblems({
    "{{count}} files": "{{count}} fichiers",
    "{{count}} files_one": "fichier",
    "Missing_other": "absent",
  }, ["{{count}} files"]);
  assert.deepEqual(broken.map(({ reason }) => reason), ["interpolation mismatch", "invalid key"]);
});

test("slot reuse preserves identities and refuses ambiguous or damaged source translations", () => {
  assert.equal(reusableTranslation("Rename {{value0}}", { "Rename {{name}}": "{{name}} 이름 변경" }), "{{value0}} 이름 변경");
  assert.equal(reusableTranslation("Rename {{value0}}", { "Rename {{name}}": "이름 변경" }), undefined);
  assert.equal(reusableTranslation("Rename {{value0}}", {
    "Rename {{name}}": "{{name}} 이름 변경", "Rename {{title}}": "{{title}} 이름 바꾸기",
  }), undefined);
  assert.equal(reusableTranslation("Remove {{value0}}", { "Rename {{name}}": "{{name}} 이름 변경" }), undefined);
});
