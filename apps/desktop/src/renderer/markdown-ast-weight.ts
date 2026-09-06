import type { MarkdownAstRoot } from "./markdown-ast";
import { estimateRetainedChars } from "./renderer-value-weight";

export const MARKDOWN_AST_CACHE_MAX_CHARACTERS = 1024 * 1024;
const weights = new WeakMap<MarkdownAstRoot, number>();

/** The parser worker already walks the result off the UI thread. Carry its
 * bounded measurement with the result; weak metadata never pins an AST. */
export function rememberMarkdownAstWeight(root: MarkdownAstRoot, chars: unknown): void {
  if (typeof chars !== "number" || !Number.isFinite(chars) || chars < 0) return;
  weights.set(root, Math.min(MARKDOWN_AST_CACHE_MAX_CHARACTERS + 1, chars));
}

export function markdownAstCacheChars(root: MarkdownAstRoot, text: string): number {
  let chars = weights.get(root);
  if (chars === undefined) {
    // Renderer fallback (or an older worker response) keeps the same bounded
    // accounting, still without building a temporary serialized AST.
    chars = estimateRetainedChars(root, MARKDOWN_AST_CACHE_MAX_CHARACTERS);
    weights.set(root, chars);
  }
  return text.length + chars;
}
