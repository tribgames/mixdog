import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const attributes = new Set([
  "aria-label", "aria-description", "ariaLabel", "placeholder", "title", "description", "status",
  "label", "emptyLabel", "displayValue", "confirmLabel", "data-tooltip", "alt",
]);
const properties = new Set([
  "label", "title", "description", "desktopDescription", "message", "emptyTitle",
  "emptyMessage", "confirmLabel", "placeholder",
]);
const languageNames = new Set([
  "English", "Español", "Français", "Deutsch", "Italiano", "Português (Brasil)", "Tiếng Việt",
]);

/** UI literals, including TS data modules and phrases held in local variables.
 * Locations are retained so a missing translation can be fixed at its owner. */
export function collectUiKeys(root, {
  explicitOnly = false,
  functions = ["t", "tExisting", "nativeT", "bootT", "earlyUiT"],
} = {}) {
  const results = new Map();
  function files(directory) {
    if (statSync(directory).isFile()) return [directory];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "locales") return [];
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path)
        : (explicitOnly ? /\.(?:[cm]?js|tsx?)$/ : /\.tsx?$/).test(entry.name)
          && !/\.(?:test|d)\./.test(entry.name) && !entry.name.includes(".integration.") ? [path] : [];
    });
  }
  for (const path of files(root)) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function add(value, node, explicit = false) {
      const key = explicit ? value : value.replace(/\s+/g, " ").trim();
      if (!key.trim() || (!explicit && (key.length < 2 || languageNames.has(key)
        || /^https?:\/\//.test(key) || /^mixdog:/.test(key)
        || /^[-\w.]+\.(?:md|tsx?|jsx?|json|css)$/.test(key)
        || !/[A-Za-z]/.test(key.replace(/\{\{[^}]+\}\}/g, ""))))) return;
      if (!results.has(key)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        results.set(key, `${relative(root, path).replaceAll("\\", "/")}:${line + 1}`);
      }
    }
    function expression(node, explicit = false) {
      if (!node) return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.text, node, explicit);
      else if (ts.isTemplateExpression(node)) {
        add(node.head.text + node.templateSpans.map((span, index) =>
          `{{value${index}}}${span.literal.text}`).join(""), node, explicit);
      } else if (ts.isConditionalExpression(node)) {
        expression(node.whenTrue, explicit);
        expression(node.whenFalse, explicit);
      } else if (ts.isBinaryExpression(node)
        && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        expression(node.left, explicit);
        expression(node.right, explicit);
      } else if (ts.isParenthesizedExpression(node)) expression(node.expression, explicit);
    }
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && functions.includes(node.expression.text)) {
        expression(node.arguments[0], true);
        return;
      }
      if (explicitOnly) {
        ts.forEachChild(node, visit);
        return;
      }
      if (ts.isJsxText(node)) {
        const parent = node.parent;
        if (ts.isJsxFragment(parent) || (ts.isJsxElement(parent)
          && !["code", "kbd", "pre", "style"].includes(parent.openingElement.tagName.getText(source)))) {
          add(node.text, node);
        }
      }
      if (ts.isJsxAttribute(node) && attributes.has(node.name.getText(source)) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) add(node.initializer.text, node.initializer);
        else if (ts.isJsxExpression(node.initializer)) expression(node.initializer.expression);
      }
      if (ts.isPropertyAssignment(node) && properties.has(node.name.getText(source))) {
        // Desktop command metadata retains a CLI description for parity, but
        // only its desktop override is rendered when one exists.
        const overridden = node.name.getText(source) === "description"
          && ts.isObjectLiteralExpression(node.parent)
          && node.parent.properties.some((property) => property.name?.getText(source) === "desktopDescription");
        if (!overridden) expression(node.initializer);
      }
      if (ts.isVariableDeclaration(node) && /(label|placeholder|title|message|tooltip|warning)$/i.test(node.name.getText(source))) {
        expression(node.initializer);
      }
      if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
        expression(node.expression);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^set(Error|Notice|Message|ListError)$/.test(node.expression.text)) expression(node.arguments[0]);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ["confirm", "prompt", "alert"].includes(node.expression.name.text)) expression(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return results;
}

export function interpolationTokens(text) {
  return [...String(text).matchAll(/\{\{[^}]+\}\}/g)].map(([token]) => token).sort();
}

/** Only an identical phrase with renamed interpolation slots can be reused. */
export function reusableTranslation(key, catalog) {
  const tokens = (text) => [...text.matchAll(/\{\{[^}]+\}\}/g)].map(([token]) => token);
  const targetTokens = tokens(key);
  if (!targetTokens.length) return undefined;
  const shape = (text) => text.replace(/\{\{[^}]+\}\}/g, "{{}}");
  const candidates = new Set();
  for (const [source, value] of Object.entries(catalog)) {
    if (source === key || typeof value !== "string" || !value.trim() || value === source || shape(source) !== shape(key)) continue;
    const sourceTokens = tokens(source);
    if (new Set(sourceTokens).size !== sourceTokens.length) continue;
    if (JSON.stringify(interpolationTokens(source)) !== JSON.stringify(interpolationTokens(value))) continue;
    const slots = new Map(sourceTokens.map((token, index) => [token, targetTokens[index]]));
    candidates.add(value.replace(/\{\{[^}]+\}\}/g, (token) => slots.get(token)));
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

export function catalogProblems(catalog, keys) {
  const problems = [];
  const required = new Set(keys);
  for (const key of new Set([...required, ...Object.keys(catalog)])) {
    const value = catalog[key];
    if (typeof value !== "string" || !value.trim()) problems.push({ key, reason: "missing or empty" });
    else if (JSON.stringify(interpolationTokens(key)) !== JSON.stringify(interpolationTokens(value))) {
      problems.push({ key, reason: "interpolation mismatch" });
    }
  }
  for (const key of Object.keys(catalog)) {
    if (key === "undefined" || (PLURAL_SUFFIX.test(key) && !required.has(key.replace(PLURAL_SUFFIX, "")))) {
      problems.push({ key, reason: "invalid key" });
    }
  }
  return problems;
}

export const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
