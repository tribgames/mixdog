// One markdown element grammar for both pipelines: the lazy react-markdown
// chunk (MarkdownBody) and the worker AST renderer (MarkdownAstBody) build
// their overrides here so links, tables, and code cards never diverge.
import React, { type ComponentType, type ReactNode } from "react";

export type MarkdownCopyControl = ComponentType<{
  value: string;
  label: string;
  className: string;
}>;

// Highlighted code children are hast-derived spans, so a plain String() cast
// no longer yields the source text for the copy button — walk the tree.
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node)) {
    return nodeText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

export function markdownComponents(CopyControl: MarkdownCopyControl) {
  return {
    a({ href, children }: { href?: string; children?: ReactNode }) {
      const raw = String(href || "").trim();
      const target = /^www\./i.test(raw) ? `https://${raw}` : raw;
      const external = /^https?:\/\//i.test(target);
      if (!external) return <a href={href}>{children}</a>;
      return <a href={target} onClick={(event) => {
        // 좌클릭만 시스템 브라우저로 연다. 보조 버튼·수식키 조합은 건드리지 않는다.
        if (event.button !== undefined && event.button !== 0) return;
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const api = window.mixdogDesktop;
        if (api?.openExternal) {
          void api.openExternal(target).catch(() => {
            try { window.open(target, "_blank", "noopener"); } catch { /* 무시 */ }
          });
          return;
        }
        try { window.open(target, "_blank", "noopener"); } catch { /* 무시 */ }
      }}>{children}</a>;
    },
    table({ children }: { children?: ReactNode }) {
      return <div className="markdown-table" role="region" aria-label="Scrollable table"
        data-scrollable tabIndex={0}>
        <table>{children}</table>
      </div>;
    },
    pre({ children }: { children?: ReactNode }) {
      const child = React.Children.count(children) === 1 ? React.Children.only(children) : null;
      if (!React.isValidElement(child)) return <pre data-scrollable>{children}</pre>;
      const props = child.props as { className?: string; children?: ReactNode };
      const language = props.className?.match(/language-([^\s]+)/)?.[1] || "";
      const code = nodeText(props.children).replace(/\n$/, "");
      return <div className="markdown-code">
        {/* No language, no label — a bare "code" caption named nothing. */}
        <header><span>{language}</span>
          <CopyControl value={code} label="Copy code" className="markdown-code-copy" /></header>
        <pre data-scrollable><code className={props.className}>{props.children}</code></pre>
      </div>;
    },
  };
}
