// Shared rehype-stage helpers used by BOTH markdown pipelines (the lazy
// react-markdown chunk and the worker AST processor) so their DOM output
// stays identical. Keep this module dependency-free: it is pulled into the
// renderer bundle and the markdown worker alike.

interface HastLikeNode {
  type?: string;
  value?: unknown;
  tagName?: unknown;
  children?: HastLikeNode[];
}

const adjacentStrongPunctuation =
  /(\*\*(?!\s)([^*\n]*?[^\s\p{L}\p{N}*])\*\*|__(?!\s)([^_\n]*?[^\s\p{L}\p{N}_])__)(?=[\p{L}\p{N}])/gu;

// CommonMark does not close `**0.118%**이며` because punctuation immediately
// precedes the closing delimiter and a Korean suffix immediately follows it.
// Repair that natural-language boundary in mdast text nodes; code and already
// parsed emphasis remain untouched, and both desktop markdown pipelines share
// the same result.
export function repairAdjacentStrongPunctuation() {
  return (tree: HastLikeNode) => {
    const visit = (node: HastLikeNode) => {
      if (node.type === "strong" || node.type === "code" || node.type === "inlineCode") return;
      const children = node.children;
      if (!children) return;
      const repaired: HastLikeNode[] = [];
      for (const child of children) {
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          repaired.push(child);
          continue;
        }
        adjacentStrongPunctuation.lastIndex = 0;
        let cursor = 0;
        for (let match = adjacentStrongPunctuation.exec(child.value);
          match;
          match = adjacentStrongPunctuation.exec(child.value)) {
          if (match.index > cursor) {
            repaired.push({ type: "text", value: child.value.slice(cursor, match.index) });
          }
          repaired.push({
            type: "strong",
            children: [{ type: "text", value: match[2] ?? match[3] ?? "" }],
          });
          cursor = match.index + match[0].length;
        }
        if (cursor === 0) {
          repaired.push(child);
        } else if (cursor < child.value.length) {
          repaired.push({ type: "text", value: child.value.slice(cursor) });
        }
      }
      node.children = repaired;
    };
    visit(tree);
  };
}

// An HTML comment is authoring metadata, never reading material. Raw HTML is
// preserved as literal text on both pipelines, which made "<!-- note -->" show
// up verbatim in the transcript; drop comment nodes (and comment runs inside a
// mixed html node) before that happens.
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

export function stripHtmlComments() {
  return (tree: HastLikeNode) => {
    const visit = (node: HastLikeNode) => {
      const children = node.children;
      if (!children) return;
      const kept: HastLikeNode[] = [];
      for (const child of children) {
        if (child.type === "html" && typeof child.value === "string") {
          HTML_COMMENT.lastIndex = 0;
          const value = child.value.replace(HTML_COMMENT, "");
          if (!value.trim()) continue;
          kept.push({ ...child, value });
          continue;
        }
        visit(child);
        kept.push(child);
      }
      node.children = kept;
    };
    visit(tree);
  };
}

// `<br>` is the only line break a GFM table cell can carry, and models reach
// for it constantly. Raw HTML stays literal on both pipelines by design, so
// that break printed the tag itself in the middle of a cell. Convert the bare
// break element — and nothing else — into an mdast `break`, leaving every
// other tag (`<b>`, `<details>`, `<script>`) literal as before.
const HTML_LINE_BREAK = /^<br\s*\/?>$/i;

export function htmlLineBreaksToBreaks() {
  return (tree: HastLikeNode) => {
    const visit = (node: HastLikeNode) => {
      const children = node.children;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (
          child.type === "html"
          && typeof child.value === "string"
          && HTML_LINE_BREAK.test(child.value.trim())
        ) {
          children[index] = { type: "break" };
          continue;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

// mdast-util-to-hast terminates every fenced block with "\n". The code
// renderer keeps the highlighted child spans instead of re-printing a
// trimmed string, so that terminator would paint an empty closing line in
// every pre-wrap code card; drop it from the final text node instead.
export function trimTrailingCodeNewline() {
  return (tree: HastLikeNode) => {
    const visit = (node: HastLikeNode) => {
      for (const child of node.children ?? []) visit(child);
      if (node.type !== "element" || node.tagName !== "pre") return;
      const code = (node.children ?? []).find(
        (child) => child.type === "element" && child.tagName === "code",
      );
      const children = code?.children;
      const last = children?.[children.length - 1];
      if (!children || !last || last.type !== "text" || typeof last.value !== "string") {
        return;
      }
      last.value = last.value.replace(/\n$/, "");
      if (!last.value) children.pop();
    };
    visit(tree);
  };
}
