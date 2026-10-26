import type { Editor } from '@tiptap/react';
import type { EditorState } from '@tiptap/pm/state';

import type { RichMarkdownPromptKind } from './rich-markdown-commands';
import { linkRangeAt } from './rich-markdown-document';
import type { OverlayPoint, PromptValues } from './RichMarkdownOverlays';

export interface PromptState {
  kind: RichMarkdownPromptKind;
  initial: PromptValues;
  withText: boolean;
  from: number;
  to: number;
  /** Position of the math node being edited. */
  nodePos?: number;
  point: OverlayPoint;
}

/** What a prompt opens with: a link edits the link around the caret (or
 *  links the selection, asking for text when there is none), a math edit
 *  carries its node, and other kinds start from the selected text. */
export function richMarkdownPromptFor(
  state: EditorState,
  kind: RichMarkdownPromptKind,
  edit: { latex: string; pos: number } | undefined,
  pointAt: (pos: number) => OverlayPoint
): PromptState {
  const { from, to } = state.selection;
  if (kind === 'link') {
    const link = linkRangeAt(state, from);
    const range = link ?? { from, to };
    return {
      kind,
      initial: { value: link?.href ?? '', text: '' },
      withText: range.from === range.to,
      ...range,
      point: pointAt(range.from),
    };
  }
  if (edit) {
    return {
      kind,
      initial: { value: edit.latex, text: '' },
      withText: false,
      from,
      to,
      nodePos: edit.pos,
      point: pointAt(edit.pos),
    };
  }
  const selected = kind === 'image' ? '' : state.doc.textBetween(from, to, ' ');
  return {
    kind,
    initial: { value: selected, text: '' },
    withText: kind === 'image',
    from,
    to,
    point: pointAt(from),
  };
}

/** Applies a submitted prompt: sets, inserts or removes the link, inserts the
 *  image, or inserts, updates or deletes the math node. */
export function applyRichMarkdownPrompt(editor: Editor, current: PromptState, values: PromptValues): void {
  const value = values.value.trim();
  const label = values.text.trim();
  const chain = editor.chain().focus();
  const range = { from: current.from, to: current.to };
  switch (current.kind) {
    case 'link':
      if (!value) chain.setTextSelection(range).extendMarkRange('link').unsetLink().run();
      else if (range.from === range.to) {
        chain
          .insertContentAt(range.from, {
            type: 'text',
            text: label || value,
            marks: [{ type: 'link', attrs: { href: value } }],
          })
          .run();
      } else chain.setTextSelection(range).extendMarkRange('link').setLink({ href: value }).run();
      return;
    case 'image':
      if (value) chain.insertContentAt(range, { type: 'image', attrs: { src: value, alt: label || null } }).run();
      return;
    case 'inlineMath':
    case 'blockMath': {
      const pos = current.nodePos;
      if (pos === undefined) {
        if (value) chain.insertContentAt(range, { type: current.kind, attrs: { latex: value } }).run();
        return;
      }
      chain
        .command(({ tr }) => {
          const node = tr.doc.nodeAt(pos);
          if (!node || node.type.name !== current.kind) return false;
          if (value) tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: value });
          else tr.delete(pos, pos + node.nodeSize);
          return true;
        })
        .run();
    }
  }
}
