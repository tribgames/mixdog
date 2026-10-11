import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface RichMarkdownSearchMatch {
  from: number;
  to: number;
}

export interface RichMarkdownSearchQuery {
  query: string;
  caseSensitive: boolean;
  /** Index of the current match, -1 for none. */
  active: number;
}

interface SearchState extends RichMarkdownSearchQuery {
  matches: RichMarkdownSearchMatch[];
  decorations: DecorationSet;
}

export const richMarkdownSearchKey = new PluginKey<SearchState>('richMarkdownSearch');

/** One character's case fold: lowercase of its uppercase, so case variants
 *  with the same uppercase fold together (final `ς` and `σ`, `ſ` and `s`,
 *  `ß` and `ss`). May be longer than the character. */
function foldCase(char: string): string {
  return char.toUpperCase().toLowerCase();
}

/** Every occurrence of `query` within a single run of text (matches never
 *  span block boundaries or non-text inline nodes such as math). */
export function findRichMarkdownMatches(
  doc: ProseMirrorNode,
  query: string,
  caseSensitive = false
): RichMarkdownSearchMatch[] {
  if (!query) return [];
  // Folded per character exactly like the document below (lowercasing a
  // whole string is context-sensitive: a final `Σ` becomes `ς`, not `σ`).
  const needle = caseSensitive ? query : Array.from(query, foldCase).join('');
  const matches: RichMarkdownSearchMatch[] = [];
  let run = '';
  let runStart = -1;
  const flush = () => {
    if (run) {
      // Lowercasing may change a character's length (`İ` → `i̇`): each unit
      // of the haystack remembers the run offsets of the character it came from.
      let haystack = run;
      let from: number[] | null = null;
      let to: number[] | null = null;
      if (!caseSensitive) {
        haystack = '';
        from = [];
        to = [];
        let offset = 0;
        for (const char of run) {
          const lower = foldCase(char);
          haystack += lower;
          for (let unit = 0; unit < lower.length; unit++) {
            from.push(offset);
            to.push(offset + char.length);
          }
          offset += char.length;
        }
      }
      for (
        let index = haystack.indexOf(needle);
        index !== -1;
        index = haystack.indexOf(needle, index + needle.length)
      ) {
        const end = index + needle.length;
        matches.push({ from: runStart + (from ? from[index] : index), to: runStart + (to ? to[end - 1] : end) });
      }
    }
    run = '';
    runStart = -1;
  };
  doc.descendants((node, pos) => {
    if (node.isText) {
      if (runStart === -1 || runStart + run.length !== pos) {
        flush();
        runStart = pos;
      }
      run += node.text ?? '';
      return false;
    }
    flush();
    return true;
  });
  flush();
  return matches;
}

function decorate(doc: ProseMirrorNode, matches: RichMarkdownSearchMatch[], active: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class: index === active ? 'rich-markdown-search-match is-active' : 'rich-markdown-search-match',
      })
    )
  );
}

function build(doc: ProseMirrorNode, query: RichMarkdownSearchQuery): SearchState {
  const matches = findRichMarkdownMatches(doc, query.query, query.caseSensitive);
  const active = matches.length ? Math.min(Math.max(query.active, 0), matches.length - 1) : -1;
  return { ...query, active, matches, decorations: decorate(doc, matches, active) };
}

export function richMarkdownSearchState(state: EditorState): SearchState | undefined {
  return richMarkdownSearchKey.getState(state);
}

/** In-document search highlighting; the query arrives as transaction meta. */
export const RichMarkdownSearch = Extension.create({
  name: 'richMarkdownSearch',
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: richMarkdownSearchKey,
        state: {
          init: () => ({ query: '', caseSensitive: false, active: -1, matches: [], decorations: DecorationSet.empty }),
          apply(tr, previous) {
            const next = tr.getMeta(richMarkdownSearchKey) as RichMarkdownSearchQuery | undefined;
            if (next) return build(tr.doc, next);
            if (tr.docChanged && previous.query) return build(tr.doc, previous);
            return previous;
          },
        },
        props: {
          decorations: (state) => richMarkdownSearchKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});
