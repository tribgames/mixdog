import { Marked, type Token, type Tokens } from 'marked';
import { t } from '../i18n';
import { splitFrontMatter } from './rich-markdown-frontmatter';

/** Above this the full-document tree and per-edit serialization make the
 *  rich editor sluggish; such files stay in Source/Preview. */
export const RICH_MARKDOWN_MAX_BYTES = 256 * 1024;

export type RichMarkdownSupport = { ok: true } | { ok: false; reason: string };

const lexer = new Marked({ gfm: true });

// Entities the editor writes back unchanged; any other reference would be
// decoded to its character and re-escaped on the next save.
const ROUND_TRIPPING_ENTITY = /^&(?:amp|lt|gt|quot);$/i;
const FOOTNOTE = /\[\^[^\]\s]+\]/;
const ENTITY = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi;
// The wrapper of a GitHub-style collapsible block, which the editor models.
const DETAILS_WRAPPER = /<details(?:\s+open)?\s*>|<summary>[^\n]*?<\/summary>|<\/details>/gi;

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

function children(token: Token): Token[] {
  const nested: Token[] = [];
  const record = token as Token & {
    tokens?: Token[];
    items?: Tokens.ListItem[];
    header?: Tokens.TableCell[];
    rows?: Tokens.TableCell[][];
  };
  if (record.tokens) nested.push(...record.tokens);
  if (record.items) nested.push(...record.items);
  if (record.header) for (const cell of record.header) nested.push(...cell.tokens);
  if (record.rows) for (const row of record.rows) for (const cell of row) nested.push(...cell.tokens);
  return nested;
}

// A table cell's line break, which the editor models as a hard break.
const CELL_LINE_BREAK = /^<br\s*\/?>$/i;

function unsupportedToken(token: Token, inCell: boolean): string | null {
  switch (token.type) {
    case 'code':
    case 'codespan':
      return null;
    case 'def':
      return (token as Tokens.Def).raw.trimStart().startsWith('[^')
        ? t('Footnotes are not supported by the rich editor.')
        : t('Reference-style link definitions are not supported by the rich editor.');
    case 'html':
      if (inCell && !(token as Tokens.HTML).block && CELL_LINE_BREAK.test(token.raw)) return null;
      if (!(token as Tokens.HTML).block || token.raw.replace(DETAILS_WRAPPER, '').trim()) {
        return t('Raw HTML is not supported by the rich editor.');
      }
      return null;
    case 'text':
    case 'escape':
      // `[^label]` is a GFM footnote reference (or definition) to the
      // preview, but plain text to the editor.
      if (FOOTNOTE.test(token.raw)) return t('Footnotes are not supported by the rich editor.');
      for (const entity of token.raw.match(ENTITY) ?? []) {
        if (!ROUND_TRIPPING_ENTITY.test(entity)) return t('HTML entities are not supported by the rich editor.');
      }
      return null;
    default:
      return null;
  }
}

/** Whether a Markdown file can be edited in the rich editor without losing or
 *  rewriting syntax it cannot model. Pure; front matter is always fine. The
 *  editor additionally proves the round trip when it loads the document. */
export function richMarkdownSupport(text: string): RichMarkdownSupport {
  return richMarkdownSizeSupport(text) ?? richMarkdownBodySupport(splitFrontMatter(text).body);
}

/** The size limit alone: a failure, or null when the file is small enough. */
export function richMarkdownSizeSupport(text: string): RichMarkdownSupport | null {
  return utf8Length(text) > RICH_MARKDOWN_MAX_BYTES
    ? { ok: false, reason: t('This file is too large for the rich editor.') }
    : null;
}

/** The syntax check of a Markdown body (or any run of whole top-level
 *  blocks of one: everything it rejects is visible within the block that
 *  holds it, and definitions are rejected wherever they are). */
export function richMarkdownBodySupport(body: string): RichMarkdownSupport {
  let tokens: ReturnType<Marked['lexer']>;
  try {
    tokens = lexer.lexer(body.replace(/\r\n?/g, '\n'));
  } catch {
    return { ok: false, reason: t('This file could not be parsed as Markdown.') };
  }
  const pending: [Token, boolean][] = tokens.map((token): [Token, boolean] => [token, false]).reverse();
  while (pending.length) {
    const [token, inCell] = pending.pop()!;
    const reason = unsupportedToken(token, inCell);
    if (reason) return { ok: false, reason };
    if (token.type !== 'code' && token.type !== 'codespan') {
      const nested = inCell || token.type === 'table';
      pending.push(
        ...children(token)
          .map((child): [Token, boolean] => [child, nested])
          .reverse()
      );
    }
  }
  const definitions = Object.keys(tokens.links ?? {});
  if (definitions.some((label) => label.startsWith('^'))) {
    return { ok: false, reason: t('Footnotes are not supported by the rich editor.') };
  }
  if (definitions.length) {
    return { ok: false, reason: t('Reference-style link definitions are not supported by the rich editor.') };
  }
  return { ok: true };
}
