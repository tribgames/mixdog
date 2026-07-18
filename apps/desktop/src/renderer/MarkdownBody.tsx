// Lazy-loaded markdown pipeline. react-markdown + remark-gfm pull the whole
// unified/remark/rehype ecosystem into whatever chunk imports them; keeping
// this file behind React.lazy removes that weight from the main bundle. The
// transcript's `.markdown` wrapper stays in App.tsx so DOM structure and
// static CSS assertions are unaffected while this chunk streams in.
import React, { type ComponentType, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownBody({ text, copyControl: CopyControl }: {
  text: string;
  copyControl: ComponentType<{ value: string; label: string; className: string }>;
}) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a({ href, children }) {
      const external = /^https?:\/\//i.test(href || "");
      return <a href={href} onClick={external ? (event) => {
        event.preventDefault();
        void window.mixdogDesktop.openExternal(href || "").catch(() => undefined);
      } : undefined}>{children}</a>;
    },
    table({ children }) {
      return <div className="markdown-table" role="region" aria-label="Scrollable table" tabIndex={0}>
        <table>{children}</table>
      </div>;
    },
    pre({ children }) {
      const child = React.Children.count(children) === 1 ? React.Children.only(children) : null;
      if (!React.isValidElement(child)) return <pre>{children}</pre>;
      const props = child.props as { className?: string; children?: ReactNode };
      const language = props.className?.match(/language-([^\s]+)/)?.[1] || "";
      const code = String(props.children ?? "").replace(/\n$/, "");
      return <div className="markdown-code">
        <header><span>{language || "code"}</span>
          <CopyControl value={code} label="Copy code" className="markdown-code-copy" /></header>
        <pre><code className={props.className}>{code}</code></pre>
      </div>;
    },
  }}>{text}</ReactMarkdown>;
}
