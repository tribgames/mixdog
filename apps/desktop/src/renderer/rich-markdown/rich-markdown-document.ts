import type { Editor } from '@tiptap/react';
import { getMarkRange, type JSONContent } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';

/** Meta on transactions that load content: they are not user edits. */
export const PROGRAMMATIC = 'richMarkdownProgrammatic';

/** The link mark around `pos` (or just after it) with its full range. */
export function linkRangeAt(state: EditorState, pos: number): { href: string; from: number; to: number } | null {
  const type = state.schema.marks.link;
  if (!type || pos < 0 || pos > state.doc.content.size) return null;
  const $pos = state.doc.resolve(pos);
  const mark = [...$pos.marks(), ...(state.doc.nodeAt(pos)?.marks ?? [])].find((candidate) => candidate.type === type);
  if (!mark) return null;
  const range = getMarkRange($pos, type, mark.attrs) ?? getMarkRange(state.doc.resolve(pos + 1), type, mark.attrs);
  return range ? { href: String(mark.attrs.href ?? ''), ...range } : null;
}

/** Loads a document without it counting as an edit. Only the part that
 *  differs is replaced, so the caret stays put across a change made
 *  elsewhere; after an undo or redo (`toChange`) it moves to the end of the
 *  changed part, where the undone or redone edit was. */
export function replaceDocument(editor: Editor, json: JSONContent, initial: boolean, toChange = false) {
  const doc = editor.schema.nodeFromJSON(json);
  const { state } = editor;
  const tr = state.tr.setMeta(PROGRAMMATIC, true);
  const start = state.doc.content.findDiffStart(doc.content);
  if (start !== null) {
    let { a: endA, b: endB } = state.doc.content.findDiffEnd(doc.content)!;
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) {
      endA += overlap;
      endB += overlap;
    }
    tr.replace(start, endA, doc.slice(start, endB));
    if (!tr.doc.eq(doc)) tr.replaceWith(0, tr.doc.content.size, doc.content);
    if (toChange)
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(endB, tr.doc.content.size)), -1)).scrollIntoView();
  }
  if (initial) tr.setSelection(TextSelection.atStart(tr.doc));
  if (tr.docChanged || initial) editor.view.dispatch(tr);
}
