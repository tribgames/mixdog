import { t } from "./i18n";

const ATTRIBUTES = ["aria-label", "placeholder", "title", "data-tooltip"] as const;
const SKIP = [
  "[data-i18n-skip]",
  "code",
  "pre",
  "kbd",
  "textarea",
  "[contenteditable='true']",
  ".monaco-editor",
  ".xterm",
  ".transcript",
  ".folder-name-text",
  ".folder-tile-label",
  ".dock-pr-row-label b",
  ".dock-scm-commit-info",
].join(",");

type TemplateMatch = {
  key: string;
  names: string[];
  expression: RegExp;
};

const templateCache = new Map<string, TemplateMatch | null>();

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templateMatch(key: string): TemplateMatch | null {
  const cached = templateCache.get(key);
  if (cached !== undefined) return cached;
  const names: string[] = [];
  let cursor = 0;
  let expressionSource = "^";
  for (const match of key.matchAll(/\{\{([^}]+)\}\}/g)) {
    expressionSource += escapeExpression(key.slice(cursor, match.index));
    expressionSource += "(.+?)";
    names.push(match[1]);
    cursor = (match.index || 0) + match[0].length;
  }
  if (!names.length) {
    templateCache.set(key, null);
    return null;
  }
  expressionSource += `${escapeExpression(key.slice(cursor))}$`;
  const compiled = { key, names, expression: new RegExp(expressionSource) };
  templateCache.set(key, compiled);
  return compiled;
}

function translatedText(value: string): string {
  const leading = value.match(/^\s*/)?.[0] || "";
  const trailing = value.match(/\s*$/)?.[0] || "";
  const source = value.slice(leading.length, value.length - trailing.length);
  if (!source || !/[A-Za-z]/.test(source)) return value;

  const exact = t(source);
  if (exact !== source) return `${leading}${exact}${trailing}`;

  // Interpolated hardcoded strings (for example "Filter files") cannot call
  // t() at their JSX source. Match them against catalog templates here.
  const catalog = (t as unknown as { autoKeys?: string[] }).autoKeys || [];
  for (const key of catalog) {
    const template = templateMatch(key);
    if (!template) continue;
    const match = template.expression.exec(source);
    if (!match) continue;
    const options = Object.fromEntries(template.names.map((name, index) => [name, match[index + 1]]));
    const translated = t(key, options);
    if (translated !== key) return `${leading}${translated}${trailing}`;
  }
  return value;
}

function skipped(element: Element | null): boolean {
  return Boolean(element?.closest(SKIP));
}

function localize(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    if (skipped(parent)) return;
    const current = node.nodeValue || "";
    const next = translatedText(current);
    if (next !== current) node.nodeValue = next;
    return;
  }
  if (!(node instanceof Element)) return;
  // Editable/technical roots keep their content untouched, but their own
  // labels and placeholders are still UI and must be localized.
  if (skipped(node.parentElement)) return;
  for (const attribute of ATTRIBUTES) {
    const current = node.getAttribute(attribute);
    if (!current) continue;
    const next = translatedText(current);
    if (next !== current) node.setAttribute(attribute, next);
  }
  if (node.matches(SKIP)) return;
  for (const child of node.childNodes) localize(child);
}

/** Localize legacy renderer literals before paint and after React mutations.
 * Explicit t() remains preferred; this compatibility lane prevents an
 * untranslated English label from leaking out of older or lazy UI surfaces. */
export function installAutoDomI18n(root: HTMLElement = document.body): () => void {
  localize(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") localize(record.target);
      else if (record.type === "attributes") localize(record.target);
      else for (const node of record.addedNodes) localize(node);
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES],
  });
  return () => observer.disconnect();
}

