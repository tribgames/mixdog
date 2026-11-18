import { unified } from 'unified';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { ensureKatexTextMetrics } from './katex-text-metrics';
import { safeMarkdownUrl } from './markdown-url';

import {
  htmlLineBreaksToBreaks,
  linkifyLocalPaths,
  repairAdjacentStrongPunctuation,
  sourceOffsets,
  stripHtmlComments,
  trimAutolinkCjkSuffix,
  trimTrailingCodeNewline,
} from './markdown-plugins';

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

/** Where the characters of text `node` (`value`) sit in `source`: its start,
 *  and the breaks in their run of consecutive offsets, as flat [value index,
 *  offset] pairs (sourceOffsets). Text that does not read off its source
 *  range has none (no text node of this renderer's parser and plugins). */
function textOffsets(node: SyntaxNode, value: string, source: string, code: boolean): { offset?: number; jumps?: number[] } {
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

const MATH_CLASS = /^(?:language-math|math-inline|math-display)$/;

function isMathNode(node: SyntaxNode): boolean {
  const className = (node.properties as { className?: unknown } | undefined)?.className;
  return Array.isArray(className) && className.some((name) => MATH_CLASS.test(String(name)));
}

function mathSource(node: SyntaxNode): string {
  if (node.type === 'text') return String(node.value ?? '');
  return Array.isArray(node.children) ? node.children.map(mathSource).join('') : '';
}

// KaTeX lends characters it has no metrics for (CJK, …) the metrics of 'M',
// which lets their ink cross a fraction bar. Hand it the measured metrics of
// the math sources' characters before rehype-katex lays them out.
function measureKatexTextGlyphs() {
  return (tree: SyntaxNode) => {
    const visit = (parent: SyntaxNode) => {
      if (!Array.isArray(parent.children)) return;
      for (const child of parent.children) {
        if (isMathNode(child)) ensureKatexTextMetrics(mathSource(child));
        else visit(child);
      }
    };
    visit(tree);
  };
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
      children: Array.isArray(node.children) ? node.children.map((child) => normalizeAstNode(child, source, inner)) : [],
    };
  }
  return {
    type: 'root',
    children: Array.isArray(node.children) ? node.children.map((child) => normalizeAstNode(child, source)) : [],
  };
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(repairAdjacentStrongPunctuation)
  .use(remarkGfm, { singleTilde: false })
  .use(trimAutolinkCjkSuffix)
  // singleDollarTextMath:false — shell/price prose ("$PATH and $5") must never
  // flip into inline math; only explicit $$…$$ math is intentional enough.
  .use(remarkMath, { singleDollarTextMath: false })
  .use(stripHtmlComments)
  // Before preserveRawHtmlAsText: once a `<br>` is frozen into a text node it
  // can no longer become a line break.
  .use(htmlLineBreaksToBreaks)
  .use(preserveRawHtmlAsText)
  .use(remarkRehype)
  .use(measureKatexTextGlyphs)
  .use(rehypeKatex)
  // Explicit-language fences only (no auto-detection); unknown languages
  // simply stay unhighlighted, matching the previous plain rendering.
  .use(rehypeHighlight)
  .use(trimTrailingCodeNewline)
  .use(linkifyLocalPaths);
// Freezing runs every plugin's attacher once (rehype-highlight registers its
// grammars), which the first parse otherwise did inside the commit that showed
// it: a phone back from the background spent ~44 ms of one resumed task (4x
// CPU) on it. The module loads ahead of that commit (preloadSyncMarkdownParser),
// so the attachers run here, in the load.
markdownProcessor.freeze();

export function parseMarkdownToHast(text: string): MarkdownAstRoot {
  const source = String(text ?? '');
  const parsed = markdownProcessor.parse(source);
  // The plugins place the text they make by the source (markdown-plugins).
  const transformed = markdownProcessor.runSync(parsed, source) as SyntaxNode;
  return normalizeAstNode(transformed, source) as MarkdownAstRoot;
}
