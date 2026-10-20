import { createContext } from 'react';
import type { MarkdownAstRoot } from './markdown-ast';

/** Display names of the group room being shown; null outside a group room. */
export const MarkdownMentionNamesContext = createContext<readonly string[] | null>(null);

type Node = MarkdownAstRoot['children'][number];

const MENTION = /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}_-]+)/gu;
const SKIP_TAGS = new Set(['code', 'pre', 'a']);

function splitText(value: string, names: ReadonlySet<string>): Node[] | null {
  const out: Node[] = [];
  let last = 0;
  for (const match of value.matchAll(MENTION)) {
    if (!names.has(match[1].toLowerCase())) continue;
    if (match.index > last) out.push({ type: 'text', value: value.slice(last, match.index) });
    out.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['agent-room-mention'] },
      children: [{ type: 'text', value: match[0] }],
    });
    last = match.index + match[0].length;
  }
  if (!last) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walk(node: Node, names: ReadonlySet<string>): Node {
  if (!node.children || (node.type === 'element' && SKIP_TAGS.has(node.tagName ?? ''))) return node;
  let changed = false;
  const children: Node[] = [];
  for (const child of node.children) {
    const split = child.type === 'text' ? splitText(child.value ?? '', names) : null;
    if (split) {
      children.push(...split);
      changed = true;
      continue;
    }
    const next = walk(child, names);
    if (next !== child) changed = true;
    children.push(next);
  }
  return changed ? { ...node, children } : node;
}

/** Wraps `@Name` tokens naming a room member (case-insensitive, whole token)
 *  in a span; code, pre and links are left alone. Returns `root` when nothing
 *  matched. */
export function highlightMentions(root: MarkdownAstRoot, memberNames: readonly string[]): MarkdownAstRoot {
  const names = new Set(memberNames.map((name) => name.toLowerCase()));
  return names.size ? (walk(root, names) as MarkdownAstRoot) : root;
}
