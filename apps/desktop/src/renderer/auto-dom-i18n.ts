import { activeUiTranslationKeys, t } from "./i18n";
import { uiTranslationTemplates } from "./auto-i18n-templates";

const ATTRIBUTES = ["aria-label", "aria-description", "placeholder", "title", "data-tooltip", "alt"] as const;
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
  // Diff bodies are source text: thousands of rows per mount, each of which
  // walked the whole template catalog here (measured as most of a diff
  // open's main-thread cost), and a code line must never be "translated".
  "[data-component='git-diff-view']",
  ".diff-fallback",
  ".folder-name-text",
  ".folder-tile-label",
  // Project identities are user content, even when they match a UI key.
  ".projects-row-label",
  ".projects-edit-dialog h2",
  ".dock-pr-row-label b",
  ".dock-scm-commit-info",
  ".queue-item-text",
].join(",");

function translatedText(value: string): string {
  const leading = value.match(/^\s*/)?.[0] || "";
  const trailing = value.match(/\s*$/)?.[0] || "";
  const source = value.slice(leading.length, value.length - trailing.length);
  if (!source || !/[A-Za-z]/.test(source)) return value;

  const exact = t(source);
  if (exact !== source) return `${leading}${exact}${trailing}`;

  // Interpolated hardcoded strings (for example "Filter files") cannot call
  // t() at their JSX source. Match them against catalog templates here.
  for (const template of uiTranslationTemplates(activeUiTranslationKeys())) {
    const match = template.expression.exec(source);
    if (!match) continue;
    const options = Object.fromEntries(template.names.map((name, index) => [name, match[index + 1]]));
    const translated = t(template.key, options);
    if (translated !== template.key && translated !== source) return `${leading}${translated}${trailing}`;
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
  if (node.matches("[data-i18n-skip]") || skipped(node.parentElement)) return;
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

