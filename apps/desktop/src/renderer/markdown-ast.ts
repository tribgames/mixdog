import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { containsMarkdownMath } from './markdown-math-detect';
import { safeMarkdownUrl } from './markdown-url';
import { rehypeSharedHighlight } from './shared-lowlight';

import {
  htmlLineBreaksToBreaks,
  linkifyLocalPaths,
  repairAdjacentStrongPunctuation,
  sourceOffsets,
  stripHtmlComments,
  trimAutolinkCjkSuffix,
  trimTrailingCodeNewline,
} from './markdown-plugins';

export { containsMarkdownMath };

interface MarkdownAstNode {
  type: 'root' | 'element' | 'text';
  tagName?: string;
  value?: string;
  /** Where the node starts in the parsed text (absent for nodes a plugin
   *  made): a streamed reply's fade finds what each character showed in by it
   *  (markdown-stream-fade). */
  offset?: number;
  /** A text node whose characters do not sit at consecutive offsets from
   *  `offset`: where the run breaks, as flat [value index, offset] pairs
   *  (sourceJumps). */
  jumps?: number[];
  properties?: Record<string, unknown>;
  children?: MarkdownAstNode[];
}

export interface MarkdownAstRoot extends MarkdownAstNode {
  type: 'root';
  children: MarkdownAstNode[];
}

interface SyntaxNode {
  type?: string;
  value?: unknown;
  tagName?: unknown;
  properties?: unknown;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: SyntaxNode[];
}

function offsetOf(node: SyntaxNode): { offset?: number } {
  const offset = node.position?.start?.offset;
  return typeof offset === 'number' ? { offset } : {};
}

/** `offset` is the text's start in `source`; `jumps` are flat [value index, offset] pairs where the run of consecutive offsets breaks. */
function textOffsets(
  node: SyntaxNode,
  value: string,
  source: string,
  code: boolean
): { offset?: number; jumps?: number[] } {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return {};
  const offsets = sourceOffsets(source, start, end, value, code);
  if (offsets === null) return {};
  const jumps: number[] = [];
  let next = start;
  offsets.forEach((offset, index) => {
    if (offset !== next) jumps.push(index, offset);
    next = offset + 1;
  });
  return jumps.length > 0 ? { offset: start, jumps } : { offset: start };
}

// react-markdown displays raw HTML as literal text unless a rehype HTML
// plugin is explicitly installed. Preserve that contract before remark-rehype
// would otherwise discard mdast `html` nodes.
function preserveRawHtmlAsText() {
  return (tree: SyntaxNode) => {
    const visit = (parent: SyntaxNode) => {
      if (!Array.isArray(parent.children)) return;
      parent.children = parent.children.map((child) => {
        if (child.type === 'html') {
          return { type: 'text', value: String(child.value ?? ''), position: child.position };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

// A table states its width, so its style needs no :has() over its rows
// (22-markdown.css): one of those, matching any cell, made every node a
// stream inserts a :has() trigger.
function markTableColumns() {
  const visit = (node: SyntaxNode) => {
    if (node.type === 'element' && node.tagName === 'table') {
      let columns = 0;
      const rows = (parent: SyntaxNode) => {
        for (const child of parent.children ?? []) {
          if (child.type !== 'element') continue;
          if (child.tagName === 'tr') {
            const cells = (child.children ?? []).filter((cell) => cell.type === 'element').length;
            columns = Math.max(columns, cells);
          } else rows(child);
        }
      };
      rows(node);
      const properties = (node.properties ?? {}) as Record<string, unknown>;
      if (columns >= 6) properties.dataWide = true;
      if (columns < 4) properties.dataNarrow = true;
      node.properties = properties;
    }
    for (const child of node.children ?? []) visit(child);
  };
  return visit;
}

function normalizedProperties(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const properties = { ...(value as Record<string, unknown>) };
  for (const name of ['href', 'src']) {
    if (typeof properties[name] === 'string') {
      properties[name] = safeMarkdownUrl(properties[name], name);
    }
  }
  return properties;
}

/** `node` of the tree parsed from `source`; `code`: inside a code element,
 *  where nothing decodes. */
function normalizeAstNode(node: SyntaxNode, source: string, code = false): MarkdownAstNode {
  if (node.type === 'text') {
    const value = String(node.value ?? '');
    return { type: 'text', value, ...textOffsets(node, value, source, code) };
  }
  if (node.type === 'element') {
    const properties = normalizedProperties(node.properties);
    const tagName = String(node.tagName || 'span');
    const inner = code || tagName === 'code';
    return {
      type: 'element',
      tagName,
      ...offsetOf(node),
      ...(properties ? { properties } : {}),
      children: Array.isArray(node.children)
        ? node.children.map((child) => normalizeAstNode(child, source, inner))
        : [],
    };
  }
  return {
    type: 'root',
    children: Array.isArray(node.children) ? node.children.map((child) => normalizeAstNode(child, source)) : [],
  };
}

type MarkdownProcessor = {
  parse(source: string): SyntaxNode;
  runSync(tree: SyntaxNode, source: string): SyntaxNode;
};

function buildProcessor(mathPlugins?: typeof import('./markdown-math-plugins')): MarkdownProcessor {
  const processor = unified()
    .use(remarkParse)
    .use(repairAdjacentStrongPunctuation)
    .use(remarkGfm, { singleTilde: false })
    .use(trimAutolinkCjkSuffix);
  if (mathPlugins) {
    // singleDollarTextMath:false — shell/price prose ("$PATH and $5") must never
    // flip into inline math; only explicit $$…$$ math is intentional enough.
    processor.use(mathPlugins.remarkMath, { singleDollarTextMath: false });
  }
  processor
    .use(stripHtmlComments)
    // Before preserveRawHtmlAsText: once a `<br>` is frozen into a text node it
    // can no longer become a line break.
    .use(htmlLineBreaksToBreaks)
    .use(preserveRawHtmlAsText)
    .use(remarkRehype);
  if (mathPlugins) {
    processor
      .use(mathPlugins.measureKatexTextGlyphs)
      // TeX that cannot typeset reads as its source in the muted text tone; the
      // reason is on hover.
      .use(mathPlugins.rehypeKatex, { errorColor: 'var(--mx-text-muted)' });
  }
  processor
    // Explicit-language fences only (no auto-detection); unknown languages
    // simply stay unhighlighted, matching the previous plain rendering.
    .use(rehypeSharedHighlight)
    .use(trimTrailingCodeNewline)
    .use(markTableColumns)
    .use(linkifyLocalPaths);
  processor.freeze();
  return processor as unknown as MarkdownProcessor;
}

const baseProcessor = buildProcessor();
let mathProcessor: MarkdownProcessor | null = null;
let mathLoadPromise: Promise<void> | null = null;

export function isMarkdownMathLoaded(): boolean {
  return mathProcessor !== null;
}

/** Loads `remark-math`, `rehype-katex` and KaTeX metrics only when text contains math. */
export function loadMarkdownMathSupport(): Promise<void> {
  if (mathProcessor) return Promise.resolve();
  if (!mathLoadPromise) {
    mathLoadPromise = import('./markdown-math-plugins')
      .then((plugins) => {
        mathProcessor = buildProcessor(plugins);
      })
      .catch((error: unknown) => {
        mathLoadPromise = null;
        throw error;
      });
  }
  return mathLoadPromise;
}

function runProcessor(processor: MarkdownProcessor, source: string): MarkdownAstRoot {
  const parsed = processor.parse(source);
  // The plugins place the text they make by the source (markdown-plugins).
  const transformed = processor.runSync(parsed, source);
  return normalizeAstNode(transformed, source) as MarkdownAstRoot;
}

export function parseMarkdownToHast(text: string): MarkdownAstRoot {
  const source = String(text ?? '');
  const processor = mathProcessor && containsMarkdownMath(source) ? mathProcessor : baseProcessor;
  return runProcessor(processor, source);
}

export async function parseMarkdownToHastAsync(text: string): Promise<MarkdownAstRoot> {
  const source = String(text ?? '');
  if (containsMarkdownMath(source) && !mathProcessor) {
    await loadMarkdownMathSupport();
  }
  const processor = mathProcessor && containsMarkdownMath(source) ? mathProcessor : baseProcessor;
  return runProcessor(processor, source);
}
