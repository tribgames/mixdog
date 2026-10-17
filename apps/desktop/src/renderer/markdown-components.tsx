// One markdown element grammar for both pipelines: the lazy react-markdown
// chunk (MarkdownBody) and the worker AST renderer (MarkdownAstBody) build
// their overrides here so links, tables, and code cards never diverge.
import React, {
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Play } from 'lucide-react';
import { t } from './i18n';
import { childrenText, MarkdownLink, MarkdownSessionContext } from './MarkdownLink';
import { LOCAL_IMAGE_TAG } from './markdown-plugins';
import { MarkdownLocalImage } from './markdown-local-image';
import {
  onTerminalCommandAvailabilityChanged,
  requestTerminalCommand,
  terminalCommandRequestsAvailable,
} from './terminal-command-request';

// Code blocks in these languages are shell commands a Run control enters in
// the conversation's terminal.
const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat']);

function RunInTerminal({ code }: { code: string }) {
  const sessionId = useContext(MarkdownSessionContext);
  const available = useSyncExternalStore(
    onTerminalCommandAvailabilityChanged,
    terminalCommandRequestsAvailable,
    terminalCommandRequestsAvailable
  );
  if (!sessionId || !available) return null;
  return (
    <button
      type="button"
      className="markdown-code-run"
      aria-label={t('Run in terminal')}
      data-tooltip={t('Run in terminal')}
      onClick={() => requestTerminalCommand(sessionId, code)}
    >
      <Play size={14} aria-hidden="true" />
    </button>
  );
}

/** The wrapper becomes a scroll container only while the table is wider than
 *  it (data-overflowing). An `overflow: auto` box that never scrolled still
 *  made Chromium hit-test every wheel over the table on the main thread, so a
 *  table that fits stays a plain box. The flag is written straight to the DOM:
 *  no React render per resize. */
function MarkdownTable({ children }: { children?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    const table = box?.firstElementChild;
    if (!box || !table || typeof ResizeObserver === 'undefined') return undefined;
    const sync = () => {
      box.toggleAttribute('data-overflowing', table.getBoundingClientRect().width > box.clientWidth + 0.5);
    };
    // No read in the commit: the observer's initial delivery runs after the
    // frame's own layout and before its paint, so the first frame still
    // carries the flag without forcing a layout per table on a session switch.
    const observer = new ResizeObserver(sync);
    observer.observe(box);
    observer.observe(table);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="markdown-table-frame">
      {/* biome-ignore lint/a11y/useSemanticElements: tag must stay a div; <section> would change the table scroller's structure. */}
      <div
        ref={scroller}
        className="markdown-table"
        role="region"
        aria-label={t('Scrollable table')}
        data-scrollable
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to focus this scroll region to scroll it.
        tabIndex={0}
      >
        <table>{children}</table>
      </div>
    </div>
  );
}

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
    [LOCAL_IMAGE_TAG]: MarkdownLocalImage,
    table: MarkdownTable,
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
            <span className="markdown-code-actions">
              {SHELL_LANGUAGES.has(language.toLowerCase()) && <RunInTerminal code={code} />}
              <CopyControl value={code} label="Copy code" className="markdown-code-copy" />
            </span>
          </header>
          <pre data-scrollable>
            <code className={props.className}>{props.children}</code>
          </pre>
        </div>
      );
    },
  };
}
