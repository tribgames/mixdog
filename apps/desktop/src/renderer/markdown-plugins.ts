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
