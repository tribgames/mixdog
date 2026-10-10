import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { MarkdownAstRoot } from './markdown-ast';
import { parseStreamingMarkdownAst, readCachedStreamingMarkdownAst } from './markdown-worker-client';
import { LocalPathMention } from './MarkdownLink';
import { CopyControl } from './transcript-primitives';
import type { ToolFileEntry, ToolOutputRow, ToolOutputSection } from './transcript-tool-sections';

const TOOL_CODE_HIGHLIGHT_MAX_CHARS = 60_000;
const TOOL_CODE_HIGHLIGHT_MAX_ROWS = 2_000;

type AstNode = MarkdownAstRoot['children'][number];

function fencedCode(text: string, language: string): string {
  const longest = [...text.matchAll(/`{3,}/g)].reduce((max, match) => Math.max(max, match[0].length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function nodeClasses(node: AstNode): string[] {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function findCodeElement(node: AstNode): AstNode | null {
  if (node.type === 'element' && node.tagName === 'code') return node;
  for (const child of node.children ?? []) {
    const found = findCodeElement(child);
    if (found) return found;
  }
  return null;
}

/** The highlighted token tree cut at every newline: one node list per line.
 *  A token keeps only its innermost class, which is what nesting paints. */
function highlightedLines(root: MarkdownAstRoot): ReactNode[][] | null {
  const code = findCodeElement(root);
  if (!code) return null;
  const lines: ReactNode[][] = [[]];
  let key = 0;
  const walk = (node: AstNode, classes: string[]) => {
    if (node.type === 'text') {
      String(node.value ?? '')
        .split('\n')
        .forEach((part, index) => {
          if (index > 0) lines.push([]);
          if (!part) return;
          lines[lines.length - 1].push(
            classes.length ? (
              <span key={key++} className={classes.join(' ')}>
                {part}
              </span>
            ) : (
              part
            )
          );
        });
      return;
    }
    const own = nodeClasses(node);
    for (const child of node.children ?? []) walk(child, own.length ? own : classes);
  };
  for (const child of code.children ?? []) walk(child, []);
  return lines;
}

interface HighlightRun {
  start: number;
  count: number;
  source: string;
}

/** Consecutive code rows, each run parsed as its own fenced block. A note row
 *  inside a numbered listing is never code, so it ends a run. */
function highlightRuns(rows: readonly ToolOutputRow[], language: string, numbered: boolean): HighlightRun[] {
  if (!language || rows.length > TOOL_CODE_HIGHLIGHT_MAX_ROWS) return [];
  const runs: HighlightRun[] = [];
  let characters = 0;
  let start = 0;
  while (start < rows.length) {
    const isCode = (row: ToolOutputRow) => !numbered || row.line != null;
    if (!isCode(rows[start])) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < rows.length && isCode(rows[end])) end += 1;
    const text = rows
      .slice(start, end)
      .map((row) => row.text)
      .join('\n');
    characters += text.length;
    if (characters > TOOL_CODE_HIGHLIGHT_MAX_CHARS) return [];
    if (text.trim()) runs.push({ start, count: end - start, source: fencedCode(text, language) });
    start = end;
  }
  return runs;
}

/** Token spans per row from the transcript's own highlighter (the markdown
 *  worker). A row has no entry while its run is pending, unavailable, or the
 *  result is over the size cap. */
function useHighlightedRows(rows: readonly ToolOutputRow[], language: string, numbered: boolean): ReactNode[][] {
  const runs = useMemo(() => highlightRuns(rows, language, numbered), [rows, language, numbered]);
  const [roots, setRoots] = useState<ReadonlyMap<string, MarkdownAstRoot>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    for (const run of runs) {
      if (readCachedStreamingMarkdownAst(run.source)) continue;
      parseStreamingMarkdownAst(run.source).then(
        (root) => {
          if (!cancelled) setRoots((current) => new Map(current).set(run.source, root));
        },
        () => {}
      );
    }
    return () => {
      cancelled = true;
    };
  }, [runs]);
  return useMemo(() => {
    const highlighted: ReactNode[][] = [];
    for (const run of runs) {
      const root = readCachedStreamingMarkdownAst(run.source) ?? roots.get(run.source);
      const lines = root ? highlightedLines(root) : null;
      if (lines?.length !== run.count) continue;
      lines.forEach((line, index) => {
        highlighted[run.start + index] = line;
      });
    }
    return highlighted;
  }, [runs, roots]);
}

/** Code as numbered rows: the gutter is its own column, so a wrapped line
 *  keeps its number on the first visual row and selection copies code only.
 *  `digits` widens the gutter to match sibling sections. */
export function ToolCode({
  rows,
  language = '',
  digits: sharedDigits = 0,
}: {
  rows: readonly ToolOutputRow[];
  language?: string;
  digits?: number;
}) {
  const own = rows.reduce((max, row) => (row.line == null ? max : Math.max(max, String(row.line).length)), 0);
  const digits = own > 0 ? Math.max(own, sharedDigits) : 0;
  const highlighted = useHighlightedRows(rows, language, digits > 0);
  return (
    <div
      className="markdown-code tool-code"
      data-numbered={digits > 0 ? 'true' : undefined}
      style={digits > 0 ? ({ '--tool-code-digits': digits } as CSSProperties) : undefined}
    >
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: code rows are positional and never reorder
        <div className="tool-code-row" data-note={digits > 0 && row.line == null ? 'true' : undefined} key={index}>
          {digits > 0 && (
            <span className="tool-code-no" aria-hidden="true">
              {row.line ?? ''}
            </span>
          )}
          <code className="tool-code-text">{highlighted[index] ?? row.text}</code>
        </div>
      ))}
    </div>
  );
}

const SHELL_TOKEN =
  /(\s+)|("(?:[^"\\]|\\.)*"?|'[^']*'?)|(&&|\|\||[|;]|\d?>>?&?\d?|<)|(\$\{?[A-Za-z_]\w*\}?|\$env:\w+)|([^\s"'|;&<>]+|.)/g;
const HERE_STRING_OPEN = /@(['"])\s*$/;
const HEREDOC_OPEN = /<<-?\s*['"]?([A-Za-z_]\w*)['"]?/;

/** One command line as shell tokens: the program each segment runs, quoted
 *  strings, variables and the operators between segments. A dozen lines of
 *  intent, not a grammar — the box only has to read like a terminal. */
function shellLineTokens(line: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  let expectProgram = true;
  let key = 0;
  for (const match of line.matchAll(SHELL_TOKEN)) {
    const [text, space, quoted, operator, variable, word] = match;
    if (space) tokens.push(text);
    else if (quoted) {
      tokens.push(
        <span key={key++} className="hljs-string">
          {text}
        </span>
      );
      expectProgram = false;
    } else if (operator) {
      tokens.push(
        <span key={key++} className="tool-shell-operator">
          {text}
        </span>
      );
      expectProgram = /^(?:&&|\|\||[|;])$/.test(text);
    } else if (variable) {
      tokens.push(
        <span key={key++} className="hljs-variable">
          {text}
        </span>
      );
      expectProgram = false;
    } else if (word) {
      // `NAME=value` before a program is an assignment, not the program.
      const program = expectProgram && !/^[A-Za-z_]\w*=/.test(text);
      tokens.push(
        program ? (
          <span key={key++} className="hljs-keyword">
            {text}
          </span>
        ) : (
          text
        )
      );
      if (program) expectProgram = false;
    }
  }
  return tokens;
}

/** A command as the terminal would show it. Lines inside a here-string or a
 *  heredoc are the script it feeds, so they stay plain. */
export function ToolCommand({ command }: { command: string }) {
  const lines = useMemo(() => {
    let closing: RegExp | null = null;
    return command.split('\n').map((line) => {
      if (closing) {
        if (closing.test(line)) closing = null;
        return [line] as ReactNode[];
      }
      const hereString = HERE_STRING_OPEN.exec(line);
      const heredoc = HEREDOC_OPEN.exec(line);
      if (hereString) closing = new RegExp(`^${hereString[1]}@`);
      else if (heredoc) closing = new RegExp(`^\\s*${heredoc[1]}\\s*$`);
      return shellLineTokens(line);
    });
  }, [command]);
  return (
    <div className="markdown-code tool-code">
      {lines.map((tokens, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: code lines are positional and never reorder
        <div className="tool-code-row" key={index}>
          <code className="tool-code-text">{tokens}</code>
        </div>
      ))}
    </div>
  );
}

export function toolCodeRowsPlain(text: string): ToolOutputRow[] {
  return text.split('\n').map((line) => ({ line: null, text: line }));
}

function pathParts(path: string): { name: string; dir: string } {
  const clean = path.replace(/[\\/]+$/, '');
  const cutAt = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return { name: clean.slice(cutAt + 1), dir: cutAt > 0 ? clean.slice(0, cutAt) : '' };
}

/** A file named the way a row names it: the name first, its folder after. */
function ToolFileName({ path, line, name, dir }: { path: string; line?: number; name: string; dir: string }) {
  return (
    <LocalPathMention path={path} line={line}>
      <b>{name}</b>
      {dir && <span className="tool-file-dir">{dir}</span>}
    </LocalPathMention>
  );
}

/** Per-file sections of one result: each opens with the file it came from and
 *  where in it, so a batch read or a search never reads as one run of text. */
export function ToolSections({ sections }: { sections: readonly ToolOutputSection[] }) {
  const digits = sections.reduce(
    (max, section) =>
      section.rows.reduce((inner, row) => (row.line == null ? inner : Math.max(inner, String(row.line).length)), max),
    0
  );
  return (
    <>
      {sections.map((section, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sections are positional and never reorder
        <div className="tool-section" key={index}>
          {(section.path || section.title) && (
            <header className="tool-section-header">
              <span className="tool-section-title" title={section.path || section.title}>
                {section.path ? (
                  <ToolFileName path={section.path} line={section.line} {...pathParts(section.path)} />
                ) : (
                  section.title
                )}
              </span>
              {section.meta && <span className="tool-section-meta">{section.meta}</span>}
            </header>
          )}
          <ToolCode rows={section.rows} language={section.language} digits={digits} />
        </div>
      ))}
    </>
  );
}

const TOOL_FILE_LIST_LINK_MAX = 200;

/** A listing as file rows: name, then folder. Past the link cap the rows stay
 *  plain text — every link resolves its own target. */
export function ToolFileList({ entries }: { entries: readonly ToolFileEntry[] }) {
  return (
    <ul className="tool-file-list">
      {entries.map((entry, index) => {
        const name = entry.kind === 'dir' ? `${entry.name}/` : entry.name;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: file rows are positional and never reorder; path alone may repeat
          <li className="tool-file-row" data-kind={entry.kind} key={`${entry.path}:${index}`} title={entry.path}>
            {index < TOOL_FILE_LIST_LINK_MAX ? (
              <ToolFileName path={entry.kind === 'dir' ? `${entry.path}/` : entry.path} name={name} dir={entry.dir} />
            ) : (
              <>
                <b>{name}</b>
                {entry.dir && <span className="tool-file-dir">{entry.dir}</span>}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The one surface every expanded tool body sits on: an optional label row, a
 *  height-capped scroll body, and a copy control. */
export function ToolPanel({
  className = '',
  kind,
  label = '',
  bare = false,
  copyValue = '',
  children,
}: {
  className?: string;
  kind?: string;
  label?: string;
  /** Prose (a rendered markdown answer) sits on the transcript, not a plate. */
  bare?: boolean;
  copyValue?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`tool-panel ${className}`.trim()}
      data-kind={kind}
      data-bare={bare ? 'true' : undefined}
      data-caption={label ? 'true' : undefined}
    >
      {label && (
        <header className="tool-panel-header">
          <span className="tool-panel-caption">{label}</span>
        </header>
      )}
      <div className="tool-panel-body" data-scrollable>
        {children}
      </div>
      {copyValue && <CopyControl className="tool-detail-copy tool-activity-copy" label="Copy" value={copyValue} />}
    </section>
  );
}
