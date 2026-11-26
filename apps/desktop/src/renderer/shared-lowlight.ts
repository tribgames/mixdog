import { common, createLowlight } from 'lowlight';

export type SharedLowlight = ReturnType<typeof createLowlight>;

let sharedLowlight: SharedLowlight | null = null;

/** Single lowlight instance shared across Markdown, diffs, source preview and rich editor. */
export function getSharedLowlight(): SharedLowlight {
  if (!sharedLowlight) {
    sharedLowlight = createLowlight(common);
  }
  return sharedLowlight;
}

export function isSharedLowlightInitialized(): boolean {
  return sharedLowlight !== null;
}

interface HighlightHastNode {
  type?: string;
  tagName?: string;
  value?: unknown;
  properties?: Record<string, unknown>;
  children?: HighlightHastNode[];
}

function codeLanguage(node: HighlightHastNode): string | false | undefined {
  const list = node.properties?.className;
  if (!Array.isArray(list)) return undefined;
  let name: string | undefined;
  for (const item of list) {
    const value = String(item);
    if (value === 'no-highlight' || value === 'nohighlight') return false;
    if (!name && value.startsWith('lang-')) name = value.slice(5);
    if (!name && value.startsWith('language-')) name = value.slice(9);
  }
  return name;
}

function hastPlainText(node: HighlightHastNode): string {
  if (node.type === 'text') return String(node.value ?? '');
  if (!Array.isArray(node.children)) return '';
  let out = '';
  for (const child of node.children) out += hastPlainText(child);
  return out;
}

/** Explicit-language fenced code highlighter backed by `getSharedLowlight()`. */
export function rehypeSharedHighlight() {
  return (tree: HighlightHastNode) => {
    const visit = (node: HighlightHastNode, parent: HighlightHastNode | null) => {
      if (
        node.type === 'element' &&
        node.tagName === 'code' &&
        parent?.type === 'element' &&
        parent.tagName === 'pre'
      ) {
        const lang = codeLanguage(node);
        if (!lang) return;
        const lowlight = getSharedLowlight();
        if (!lowlight.registered(lang)) return;
        let properties = node.properties;
        if (!properties) {
          properties = {};
          node.properties = properties;
        }
        let className: unknown[];
        if (Array.isArray(properties.className)) {
          className = properties.className;
        } else {
          className = [];
          properties.className = className;
        }
        if (!className.includes('hljs')) className.unshift('hljs');
        try {
          const result = lowlight.highlight(lang, hastPlainText(node));
          if (result.children.length > 0) {
            node.children = result.children as unknown as HighlightHastNode[];
          }
        } catch {
          // Unknown or failing grammar leaves the code node unhighlighted.
        }
        return;
      }
      if (!Array.isArray(node.children)) return;
      for (const child of node.children) visit(child, node);
    };
    visit(tree, null);
  };
}
