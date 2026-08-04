import { unified } from "unified";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";

import { trimTrailingCodeNewline } from "./markdown-plugins";

export interface MarkdownAstNode {
  type: "root" | "element" | "text";
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownAstNode[];
}

export interface MarkdownAstRoot extends MarkdownAstNode {
  type: "root";
  children: MarkdownAstNode[];
}

interface SyntaxNode {
  type?: string;
  value?: unknown;
  tagName?: unknown;
  properties?: unknown;
  children?: SyntaxNode[];
}

const safeProtocol = /^(?:https?|ircs?|mailto|xmpp)$/i;

function safeMarkdownUrl(value: string): string {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");
  if (
    colon === -1
    || (slash !== -1 && colon > slash)
    || (questionMark !== -1 && colon > questionMark)
    || (numberSign !== -1 && colon > numberSign)
    || safeProtocol.test(value.slice(0, colon))
  ) {
    return value;
  }
  return "";
}

// react-markdown displays raw HTML as literal text unless a rehype HTML
// plugin is explicitly installed. Preserve that contract before remark-rehype
// would otherwise discard mdast `html` nodes.
function preserveRawHtmlAsText() {
  return (tree: SyntaxNode) => {
    const visit = (parent: SyntaxNode) => {
      if (!Array.isArray(parent.children)) return;
      parent.children = parent.children.map((child) => {
        if (child.type === "html") {
          return { type: "text", value: String(child.value ?? "") };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

function normalizedProperties(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const properties = { ...(value as Record<string, unknown>) };
  for (const name of ["href", "src"]) {
    if (typeof properties[name] === "string") {
      properties[name] = safeMarkdownUrl(properties[name]);
    }
  }
  return properties;
}

function normalizeAstNode(node: SyntaxNode): MarkdownAstNode {
  if (node.type === "text") {
    return { type: "text", value: String(node.value ?? "") };
  }
  if (node.type === "element") {
    return {
      type: "element",
      tagName: String(node.tagName || "span"),
      ...(normalizedProperties(node.properties)
        ? { properties: normalizedProperties(node.properties) }
        : {}),
      children: Array.isArray(node.children) ? node.children.map(normalizeAstNode) : [],
    };
  }
  return {
    type: "root",
    children: Array.isArray(node.children) ? node.children.map(normalizeAstNode) : [],
  };
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  // singleDollarTextMath:false — shell/price prose ("$PATH and $5") must never
  // flip into inline math; only explicit $$…$$ math is intentional enough.
  .use(remarkMath, { singleDollarTextMath: false })
  .use(preserveRawHtmlAsText)
  .use(remarkRehype)
  .use(rehypeKatex)
  // Explicit-language fences only (no auto-detection); unknown languages
  // simply stay unhighlighted, matching the previous plain rendering.
  .use(rehypeHighlight)
  .use(trimTrailingCodeNewline);

export function parseMarkdownToHast(text: string): MarkdownAstRoot {
  const parsed = markdownProcessor.parse(String(text ?? ""));
  const transformed = markdownProcessor.runSync(parsed) as SyntaxNode;
  return normalizeAstNode(transformed) as MarkdownAstRoot;
}
