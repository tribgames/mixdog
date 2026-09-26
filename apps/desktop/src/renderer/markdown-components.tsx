// One markdown element grammar for both pipelines: the lazy react-markdown
// chunk (MarkdownBody) and the worker AST renderer (MarkdownAstBody) build
// their overrides here so links, tables, and code cards never diverge.
import React, { type ComponentType, type ReactNode } from 'react';
import { childrenText, MarkdownLink } from './MarkdownLink';

export type MarkdownCopyControl = ComponentType<{
  value: string;
  label: string;
  className: string;
}>;

type MarkdownComponents = ReturnType<typeof createMarkdownComponents>;

// Component types must be stable: toJsxRuntime runs on every landed parse of a
// live tail, and a fresh `pre`/`table` type per call remounted every code card
// and table wrapper (with its copy control) on each streamed token.
const componentsByCopyControl = new WeakMap<MarkdownCopyControl, MarkdownComponents>();

export function markdownComponents(CopyControl: MarkdownCopyControl): MarkdownComponents {
  let components = componentsByCopyControl.get(CopyControl);
  if (!components) {
    components = createMarkdownComponents(CopyControl);
    componentsByCopyControl.set(CopyControl, components);
  }
  return components;
}

function createMarkdownComponents(CopyControl: MarkdownCopyControl) {
  return {
    a: MarkdownLink,
    table({ children }: { children?: ReactNode }) {
      return (
        <div className="markdown-table" role="region" aria-label="Scrollable table" data-scrollable tabIndex={0}>
          <table>{children}</table>
        </div>
      );
    },
    pre({ children }: { children?: ReactNode }) {
      const child = React.Children.count(children) === 1 ? React.Children.only(children) : null;
      if (!React.isValidElement(child)) return <pre data-scrollable>{children}</pre>;
      const props = child.props as { className?: string; children?: ReactNode };
      const language = props.className?.match(/language-([^\s]+)/)?.[1] || '';
      const code = childrenText(props.children).replace(/\n$/, '');
      return (
        <div className="markdown-code">
          {/* No language, no label — a bare "code" caption named nothing. */}
          <header>
            <span>{language}</span>
            <CopyControl value={code} label="Copy code" className="markdown-code-copy" />
          </header>
          <pre data-scrollable>
            <code className={props.className}>{props.children}</code>
          </pre>
        </div>
      );
    },
  };
}
