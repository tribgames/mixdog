import {
  Extension,
  type AnyExtension,
  type JSONContent,
  type MarkdownToken,
  type NodeViewRenderer,
} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Paragraph from '@tiptap/extension-paragraph';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Markdown } from '@tiptap/markdown';
import { common, createLowlight } from 'lowlight';
import { Marked } from 'marked';
import { t } from '../i18n';

export const richMarkdownLowlight = createLowlight(common);

type MarkedExtensionList = {
  extensions?: Array<{ level?: string; start?: (this: unknown, src: string) => number | void }>;
};

/**
 * A private marked instance whose block-level extension `start` probes only
 * see the source up to the next blank line. marked uses those probes only
 * to cut the paragraph being read, which never reaches past a blank line,
 * so the tokens are the same; but unbounded probes (`indexOf`, splitting
 * the rest into lines) scan the whole remaining document for every
 * paragraph, which made lexing quadratic in the document's length.
 */
export function richMarkdownMarked(): Marked {
  const marked = new Marked();
  const use = marked.use.bind(marked);
  marked.use = (...extensions: Parameters<Marked['use']>) =>
    use(
      ...extensions.map((extension) => {
        const list = (extension as MarkedExtensionList).extensions;
        if (!list) return extension;
        return {
          ...extension,
          extensions: list.map((spec) => {
            const start = spec.start;
            if (spec.level !== 'block' || typeof start !== 'function') return spec;
            return {
              ...spec,
              start(this: unknown, src: string) {
                const blank = /\n[ \t]*(?:\n|$)/.exec(src);
                return start.call(this, blank ? src.slice(0, blank.index + blank[0].length) : src);
              },
            };
          }),
        } as (typeof extensions)[number];
      })
    );
  return marked;
}

/** Node views the live editor plugs in; the headless codec renders none. */
export interface RichMarkdownNodeViews {
  codeBlock?: NodeViewRenderer;
  image?: NodeViewRenderer;
}

type DetailsToken = MarkdownToken & {
  open: boolean;
  summaryTokens: MarkdownToken[];
  bodyTokens: MarkdownToken[];
};

const DETAILS_BLOCK =
  /^<details(\s+open)?\s*>[ \t]*\n?[ \t]*<summary>([^\n]*?)<\/summary>[ \t]*\n([\s\S]*?)\n?<\/details>[ \t]*(?:\n|$)/;

/** One `<details>` block in GitHub's shape: a one-line summary and a Markdown
 *  body. Nested or attribute-laden blocks stay raw HTML (unsupported). */
function matchDetailsBlock(src: string): { raw: string; open: boolean; summary: string; body: string } | null {
  const match = DETAILS_BLOCK.exec(src);
  if (!match || /<\/?details\b/i.test(match[3])) return null;
  return { raw: match[0], open: Boolean(match[1]), summary: match[2].trim(), body: match[3].trim() };
}

const escapeHtmlText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const RichDetails = Details.extend({
  addAttributes() {
    // `open` as authored: it sets the initial fold and is written back
    // unchanged. Toggling (persist: false) only folds the view, so viewing a
    // section never edits the document.
    return {
      ...this.parent?.(),
      open: { default: false, rendered: false },
    };
  },
  markdownTokenizer: {
    name: 'details',
    level: 'block',
    start: (src: string) => src.indexOf('<details'),
    tokenize(src, _tokens, lexer) {
      const block = matchDetailsBlock(src);
      if (!block) return undefined;
      return {
        type: 'details',
        raw: block.raw,
        open: block.open,
        summaryTokens: lexer.inlineTokens(block.summary),
        bodyTokens: lexer.blockTokens(block.body),
      } as DetailsToken;
    },
  },
  parseMarkdown(token, helpers) {
    const details = token as DetailsToken;
    const summary = helpers.createNode('detailsSummary', {}, helpers.parseInline(details.summaryTokens ?? []));
    const body = helpers.parseChildren(details.bodyTokens ?? []);
    const content = helpers.createNode('detailsContent', {}, body.length ? body : [helpers.createNode('paragraph')]);
    return helpers.createNode('details', { open: details.open }, [summary, content]);
  },
  renderMarkdown(node, helpers) {
    const summary = node.content?.find((child) => child.type === 'detailsSummary');
    const content = node.content?.find((child) => child.type === 'detailsContent');
    const title = helpers.renderChildren(summary?.content ?? [], '');
    const body = helpers.renderChildren(content?.content ?? [], '\n\n').trim();
    const open = node.attrs?.open ? ' open' : '';
    return `<details${open}>\n<summary>${escapeHtmlText(title)}</summary>\n\n${body}\n\n</details>`;
  },
});

// Pandoc's rule: `$` must hug its content and a closing `$` must not run into
// a digit, so prices like `$5 and $10` stay text instead of becoming math.
export const INLINE_MATH_SOURCE = String.raw`\$(?![\s$])((?:\\[\s\S]|[^$\\\n])+?)(?<!\s)\$(?!\d)`;
const INLINE_MATH = new RegExp(`^${INLINE_MATH_SOURCE}`);

const RichInlineMath = InlineMath.extend({
  markdownTokenizer: {
    name: 'inlineMath',
    level: 'inline',
    start: (src: string) => src.indexOf('$'),
    tokenize(src: string) {
      const match = INLINE_MATH.exec(src);
      return match ? { type: 'inlineMath', raw: match[0], latex: match[1] } : undefined;
    },
  },
});

/** A backtick fence longer than any backtick run opening a line of `code`,
 *  so no line of the code can close the block early. */
function codeFence(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(/^ {0,3}(`+)/gm)) longest = Math.max(longest, match[1].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

const RichCodeBlock = CodeBlockLowlight.extend({
  renderMarkdown: (node, helpers) => {
    const language = node.attrs?.language || '';
    const code = node.content ? helpers.renderChildren(node.content) : '';
    const fence = codeFence(code);
    return `${fence}${language}\n${code}\n${fence}`;
  },
});

/** `<br>` is a table cell's only line break: it parses as a hard break,
 *  which a cell writes back as `<br>`. */
const HtmlLineBreak = Extension.create({
  name: 'htmlLineBreak',
  markdownTokenizer: {
    name: 'htmlLineBreak',
    level: 'inline',
    start: (src: string) => src.search(/<br\s*\/?>/i),
    tokenize(src: string) {
      const match = /^<br\s*\/?>/i.exec(src);
      return match ? { type: 'br', raw: match[0] } : undefined;
    },
  },
});

/** Enter inside a table cell breaks the line: a cell holds a single
 *  paragraph in Markdown. */
const TableCellLineBreak = Extension.create({
  name: 'tableCellLineBreak',
  priority: 200,
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) =>
        !editor.state.selection.$from.parent.type.spec.code &&
        (editor.isActive('tableCell') || editor.isActive('tableHeader')) &&
        editor.commands.setHardBreak(),
    };
  },
});

const TASK_ITEM_LINE = /^(\s*)([-+*])\s+\[([ xX])\]\s+(.*)$/;
const taskListTokenizer = TaskList.config.markdownTokenizer!;

/** The task list tokenizer runs at every block and splits the whole rest of
 *  the document into lines (and re-slices it at every blank line), which
 *  made lexing quadratic. It is skipped when its own first-line test (the
 *  first non-blank line must be a task item) already fails; otherwise it
 *  runs on the source up to and including the first unindented line that
 *  is not a task item: it always stops at that line, and looks no further
 *  than it, so the result is the same. */
const RichTaskList = TaskList.extend({
  markdownTokenizer: {
    ...taskListTokenizer,
    tokenize(src, tokens, lexer) {
      let pos = 0;
      let first = true;
      for (;;) {
        const end = src.indexOf('\n', pos);
        const line = src.slice(pos, end === -1 ? undefined : end);
        if (first) {
          if (line.trim() !== '') {
            if (!TASK_ITEM_LINE.test(line)) return undefined;
            first = false;
          } else if (end === -1) return undefined;
        } else if (line && !/^\s/.test(line) && !TASK_ITEM_LINE.test(line)) {
          return taskListTokenizer.tokenize(src.slice(0, end === -1 ? src.length : end + 1), tokens, lexer);
        }
        if (end === -1) break;
        pos = end + 1;
      }
      return taskListTokenizer.tokenize(src, tokens, lexer);
    },
  },
});

// The summary is parsed as inline Markdown, so it must accept any inline node.
const RichDetailsSummary = DetailsSummary.extend({ content: 'inline*' });

const RichParagraph = Paragraph.extend({
  parseMarkdown(token, helpers) {
    const tokens = token.tokens ?? [];
    // Images are inline here: a lone image stays inside its paragraph rather
    // than becoming a block the document schema rejects.
    if (tokens.length === 1 && tokens[0].type === 'image') {
      return helpers.createNode('paragraph', undefined, helpers.parseInline(tokens));
    }
    const parent = Paragraph.config.parseMarkdown;
    return parent
      ? parent.call(this, token, helpers)
      : helpers.createNode('paragraph', undefined, helpers.parseInline(tokens));
  },
  // Markdown cannot hold an empty paragraph (blank lines between blocks
  // carry them); text lines are escaped so they stay text.
  renderMarkdown: (node, helpers) =>
    node.content?.length ? escapeParagraphLines(helpers.renderChildren(node.content)) : '',
});

/** A paragraph's rendered lines with whatever would start a block escaped:
 *  headings, quotes, list markers, setext and thematic breaks, table
 *  delimiter rows; leading whitespace (indented code) is dropped, as
 *  Markdown drops it anyway. Inline markup never begins with these
 *  characters, so only literal text is escaped. */
function escapeParagraphLines(markdown: string): string {
  return markdown
    .split('\n')
    .map((raw) => {
      const line = raw.replace(/^[ \t]+/, '');
      const ordinal = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(line);
      if (ordinal) return `${ordinal[1]}\\${line.slice(ordinal[1].length)}`;
      return /^(?:#{1,6}(?=[ \t]|$)|>|[-+](?=[ \t]|$)|=+[ \t]*$|[-:|][-:| \t]*$)/.test(line) ? `\\${line}` : line;
    })
    .join('\n');
}

export interface RichMarkdownExtensionOptions {
  nodeViews?: RichMarkdownNodeViews;
  /** Extra editor-only extensions (placeholder, search, keymaps). */
  extra?: AnyExtension[];
  /** A click on rendered math (to edit its LaTeX). */
  onMathClick?: (kind: 'inlineMath' | 'blockMath', latex: string, pos: number) => void;
}

/** The one extension set behind both the live editor and the headless codec,
 *  so a document judged round-trippable is exactly what the editor writes. */
export function createRichMarkdownExtensions({
  nodeViews = {},
  extra = [],
  onMathClick,
}: RichMarkdownExtensionOptions = {}): AnyExtension[] {
  const codeBlock = RichCodeBlock.configure({ lowlight: richMarkdownLowlight, defaultLanguage: null });
  const image = Image.configure({ inline: true, allowBase64: false });
  return [
    StarterKit.configure({
      codeBlock: false,
      paragraph: false,
      // Underline has no Markdown syntax: it would be written as raw HTML.
      underline: false,
      // Undo and redo run on the Monaco model's history, shared with Source.
      undoRedo: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true, enableClickSelection: false },
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    RichParagraph,
    nodeViews.codeBlock ? codeBlock.extend({ addNodeView: () => nodeViews.codeBlock! }) : codeBlock,
    nodeViews.image ? image.extend({ addNodeView: () => nodeViews.image! }) : image,
    RichTaskList,
    TaskItem.configure({
      nested: true,
      a11y: {
        checkboxLabel: (node) =>
          node.textContent ? t('Task item: {{text}}', { text: node.textContent }) : t('Empty task item'),
      },
    }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    HtmlLineBreak,
    TableCellLineBreak,
    RichInlineMath.configure({
      katexOptions: { throwOnError: false },
      onClick: onMathClick ? (node, pos) => onMathClick('inlineMath', String(node.attrs.latex ?? ''), pos) : undefined,
    }),
    BlockMath.configure({
      katexOptions: { throwOnError: false, displayMode: true },
      onClick: onMathClick ? (node, pos) => onMathClick('blockMath', String(node.attrs.latex ?? ''), pos) : undefined,
    }),
    RichDetails.configure({
      persist: false,
      HTMLAttributes: { class: 'rich-markdown-details' },
      renderToggleButton: ({ element, isOpen }) =>
        element.setAttribute('aria-label', isOpen ? t('Collapse section') : t('Expand section')),
    }),
    RichDetailsSummary,
    DetailsContent,
    // A private marked instance per editor: tokenizers registered by one
    // editor never leak into another or into the app's own Markdown pipeline.
    // (A Marked instance carries everything the manager uses of the module API.)
    Markdown.configure({ marked: richMarkdownMarked() as never, markedOptions: { gfm: true } }),
    ...extra,
  ];
}

export type { JSONContent };
