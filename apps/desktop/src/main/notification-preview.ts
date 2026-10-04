import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { repairAdjacentStrongPunctuation } from '../renderer/markdown-plugins';

// The transcript's own Markdown dialect: GFM tables and strikethrough, and the
// Hangul strong repair (`**…)**는` is not CommonMark emphasis). Without them a
// banner showed raw `**` and `|` (user: 마크다운이 노출되는데).
const parser = unified().use(remarkParse).use(repairAdjacentStrongPunctuation).use(remarkGfm, { singleTilde: false });
interface TextNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: TextNode[];
}

const LIMIT = 160;
/** A cut at a sentence end must still carry a real summary. */
const MIN_SENTENCE = 60;
/** Blocks a banner cannot summarize: their text is code or grid, not prose. */
const SKIPPED = new Set(['code', 'math', 'table', 'html', 'definition', 'footnoteDefinition', 'thematicBreak']);

function plainText(node: TextNode): string {
  if (SKIPPED.has(node.type)) return '';
  if (node.type === 'image') return node.alt || '';
  if (node.type === 'break') return ' ';
  if (node.type === 'inlineCode') return node.value || '';
  // A delimiter the parser could not pair is still syntax, not text.
  if (node.type === 'text') return (node.value || '').replace(/\*\*/gu, '');
  if (typeof node.value === 'string') return node.value;
  const separator = ['root', 'blockquote', 'list', 'listItem'].includes(node.type) ? ' ' : '';
  return (node.children || []).map(plainText).join(separator);
}

/** Native banners display text, not Markdown. Parse BEFORE clipping so a
 * truncated link/emphasis delimiter cannot leak into the notification. A long
 * answer ends on its last whole sentence that fits rather than mid-word. */
export function notificationPreview(markdown: string): string {
  const tree = parser.runSync(parser.parse(markdown)) as TextNode;
  const text = plainText(tree).replace(/\s+/gu, ' ').trim();
  const characters = Array.from(text);
  if (characters.length <= LIMIT) return text;
  // One character past the limit, so a period that ends exactly at it still
  // sees the space that follows.
  const probe = characters.slice(0, LIMIT + 1).join('');
  const sentenceEnd = [...probe.matchAll(/[.!?。！？](?=\s)/gu)].at(-1);
  if (sentenceEnd?.index !== undefined) {
    const sentence = probe.slice(0, sentenceEnd.index + 1);
    if (Array.from(sentence).length >= MIN_SENTENCE) return sentence;
  }
  return `${characters.slice(0, LIMIT - 1).join('')}…`;
}
