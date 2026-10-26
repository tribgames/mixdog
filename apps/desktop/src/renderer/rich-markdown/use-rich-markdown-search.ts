import type { Editor } from '@tiptap/react';
import { type RefObject, useState } from 'react';

import { richMarkdownSearchKey, richMarkdownSearchState } from './rich-markdown-search';

export interface SearchUiState {
  query: string;
  caseSensitive: boolean;
  active: number;
  count: number;
}

/** Find in the document: the search bar's state, mirrored into the search
 *  plugin, with the active match scrolled into view. */
export function useRichMarkdownSearch(editor: Editor, canvasRef: RefObject<HTMLDivElement | null>) {
  const [search, setSearch] = useState<SearchUiState | null>(null);

  const applySearch = (next: Omit<SearchUiState, 'count'>, reveal: boolean) => {
    editor.view.dispatch(editor.state.tr.setMeta(richMarkdownSearchKey, next));
    const state = richMarkdownSearchState(editor.state);
    setSearch({ ...next, active: state?.active ?? -1, count: state?.matches.length ?? 0 });
    if (!reveal) return;
    requestAnimationFrame(() =>
      canvasRef.current?.querySelector('.rich-markdown-search-match.is-active')?.scrollIntoView?.({ block: 'center' })
    );
  };

  const openSearch = () => {
    const { from, to } = editor.state.selection;
    const selected = editor.state.doc.textBetween(from, to, ' ');
    const query = selected && !selected.includes('\n') ? selected : (search?.query ?? '');
    applySearch({ query, caseSensitive: search?.caseSensitive ?? false, active: 0 }, true);
  };

  const closeSearch = () => {
    applySearch({ query: '', caseSensitive: false, active: -1 }, false);
    setSearch(null);
    editor.commands.focus();
  };

  /** Keeps the match count and active match current after an edit. */
  const followEdit = () => {
    if (!search) return;
    const found = richMarkdownSearchState(editor.state);
    setSearch({ ...search, active: found?.active ?? -1, count: found?.matches.length ?? 0 });
  };

  return { search, applySearch, openSearch, closeSearch, followEdit };
}
