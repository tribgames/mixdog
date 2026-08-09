// i18n catalog validation (npm run i18n:check).
// Fails when any locale file under src/renderer/locales (a) is missing keys
// that other locales carry, (b) still holds empty ("" = untranslated) values,
// or (c) carries plural-suffix keys (key_one/…) — those are extractor
// artifacts that override real translations with English key text and are
// pruned by scripts/sync-i18n.mjs. Untranslated keys are SAFE at runtime
// (English pass-through); this gate surfaces omissions instead of letting
// them ship silently.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const localesDir = new URL("../src/renderer/locales/", import.meta.url);
const supplementalPath = new URL("../src/renderer/auto-i18n-pack.json", import.meta.url);
const files = readdirSync(localesDir).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) {
  console.error("check-i18n: no locale files found");
  process.exit(1);
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const INTERPOLATION = /\{\{[^}]+\}\}/g;

const catalogs = new Map();
for (const name of files) {
  catalogs.set(name, JSON.parse(readFileSync(new URL(name, localesDir), "utf8")));
}

const supplemental = JSON.parse(readFileSync(supplementalPath, "utf8"));
const supplementalKeys = Object.keys(supplemental)
  .filter((key) => /^keys\d+$/.test(key))
  .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
  .flatMap((key) => supplemental[key]);
const supplementalKo = Object.keys(supplemental)
  .filter((key) => /^ko\d+$/.test(key))
  .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
  .flatMap((key) => supplemental[key]);
if (supplementalKeys.length !== supplementalKo.length
  || supplementalKeys.some((key, index) => !key || !supplementalKo[index])) {
  console.error("check-i18n: supplemental Korean catalog is misaligned or empty.");
  process.exit(1);
}
for (const locale of ["ja", "zh-CN", "zh-TW", "es", "fr", "de", "it", "pt-BR", "ru", "vi"]) {
  if (!Array.isArray(supplemental[locale])
    || supplemental[locale].length !== supplemental.sharedIndices.length
    || supplemental[locale].some((value) => !value)) {
    console.error(`check-i18n: supplemental ${locale} catalog is misaligned or empty.`);
    process.exit(1);
  }
}

// Legacy/lazy renderer surfaces still contain English JSX literals. Keep the
// compatibility catalog honest: a new visible literal must exist either in a
// normal locale catalog or in the supplemental catalog before it can ship.
const literalAttributes = new Set([
  "aria-label", "ariaLabel", "placeholder", "title", "description", "status",
  "label", "emptyLabel", "displayValue", "confirmLabel", "data-tooltip", "alt",
]);
const literalProperties = new Set([
  "label", "title", "description", "message", "emptyTitle", "emptyMessage",
  "confirmLabel", "placeholder",
]);
const visibleLiterals = new Set();
const addLiteral = (value) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || !/[A-Za-z]/.test(text) || text.length < 2 || /^https?:\/\//.test(text)) return;
  if (/^[-\w.]+\.(?:md|tsx?|jsx?|json|css)$/.test(text)) return;
  visibleLiterals.add(text);
};
const addExpression = (expression) => {
  if (!expression) return;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    addLiteral(expression.text);
  } else if (ts.isTemplateExpression(expression)) {
    let text = expression.head.text;
    expression.templateSpans.forEach((span, index) => {
      text += `{{value${index}}}${span.literal.text}`;
    });
    addLiteral(text);
  } else if (ts.isConditionalExpression(expression)) {
    addExpression(expression.whenTrue);
    addExpression(expression.whenFalse);
  } else if (ts.isBinaryExpression(expression)
    && (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    addExpression(expression.left);
    addExpression(expression.right);
  } else if (ts.isParenthesizedExpression(expression)) {
    addExpression(expression.expression);
  }
};
const rendererRoot = fileURLToPath(new URL("../src/renderer/", import.meta.url));
const sourceFiles = [];
const collectSources = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "locales") continue;
    const target = join(directory, entry.name);
    if (entry.isDirectory()) collectSources(target);
    else if (/\.tsx$/.test(entry.name) && !entry.name.includes(".test.")) sourceFiles.push(target);
  }
};
collectSources(rendererRoot);
for (const path of sourceFiles) {
  const sourceFile = ts.createSourceFile(
    path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") return;
    if (ts.isJsxText(node)) {
      const parent = node.parent;
      if ((ts.isJsxElement(parent)
        && !["code", "kbd", "pre", "style"].includes(parent.openingElement.tagName.getText(sourceFile)))
        || ts.isJsxFragment(parent)) addLiteral(node.text);
    }
    if (ts.isJsxAttribute(node) && literalAttributes.has(node.name.getText(sourceFile)) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) addLiteral(node.initializer.text);
      else if (ts.isJsxExpression(node.initializer)) addExpression(node.initializer.expression);
    }
    if (ts.isPropertyAssignment(node) && literalProperties.has(node.name.getText(sourceFile))) {
      addExpression(node.initializer);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && /^set(Error|Notice|Message|ListError)$/.test(node.expression.text)) {
      addExpression(node.arguments[0]);
    }
    if (ts.isJsxExpression(node)
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      addExpression(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const union = new Set();
for (const catalog of catalogs.values()) {
  for (const key of Object.keys(catalog)) {
    if (!PLURAL_SUFFIX.test(key)) union.add(key);
  }
}
const coveredUiKeys = new Set([...union, ...supplementalKeys]);
const uncoveredLiterals = [...visibleLiterals].filter((key) => !coveredUiKeys.has(key));
if (uncoveredLiterals.length > 0) {
  console.error(`check-i18n: ${uncoveredLiterals.length} visible renderer literals lack translations.`);
  for (const key of uncoveredLiterals.slice(0, 20)) console.error(`  · ${key}`);
  process.exit(1);
}

let failed = false;
for (const [name, catalog] of catalogs) {
  const empty = Object.entries(catalog)
    .filter(([, value]) => typeof value !== "string" || value === "")
    .map(([key]) => key);
  const missing = [...union].filter((key) => !(key in catalog));
  const plural = Object.keys(catalog).filter((key) => PLURAL_SUFFIX.test(key));
  const interpolation = Object.entries(catalog)
    .filter(([key, value]) => {
      if (typeof value !== "string") return false;
      const expected = [...key.matchAll(INTERPOLATION)].map(([token]) => token).sort();
      const actual = [...value.matchAll(INTERPOLATION)].map(([token]) => token).sort();
      return expected.join("\0") !== actual.join("\0");
    })
    .map(([key]) => key);
  if (empty.length === 0 && missing.length === 0 && plural.length === 0 && interpolation.length === 0) continue;
  failed = true;
  console.error(`check-i18n: ${name} — empty: ${empty.length}, missing: ${missing.length}, plural artifacts: ${plural.length}, interpolation mismatches: ${interpolation.length}`);
  for (const key of [...empty.slice(0, 10), ...missing.slice(0, 10), ...plural.slice(0, 5), ...interpolation.slice(0, 10)]) {
    console.error(`  · ${key}`);
  }
  if (empty.length + missing.length + plural.length + interpolation.length > 35) console.error("  · …");
}

if (failed) {
  console.error("check-i18n: FAILED — run `npm run i18n:sync` and fill the listed keys.");
  process.exit(1);
}
console.log(`check-i18n: OK — ${files.length} locales × ${union.size} keys, no gaps.`);
