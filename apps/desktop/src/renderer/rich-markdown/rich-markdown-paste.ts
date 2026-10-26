import type { Editor } from '@tiptap/react';

import { looksLikeMarkdown } from './rich-markdown-commands';
import { checkRichMarkdownRoundTrip, richMarkdownCodecFor } from './rich-markdown-codec';
import { richMarkdownBodySupport } from './rich-markdown-support';

/** Pastes plain-text Markdown as rich content, or as literal paragraphs when
 *  the editor cannot represent it faithfully. Returns false (the default
 *  paste runs) for read-only, code blocks, rich HTML and non-Markdown text. */
export function pasteRichMarkdown(editor: Editor, event: ClipboardEvent): boolean {
  const data = event.clipboardData;
  const plain = data?.getData('text/plain') ?? '';
  if (!editor.isEditable || !plain || editor.state.selection.$from.parent.type.spec.code) return false;
  // Rich HTML (a web page, a document) already carries its structure.
  const html = data?.getData('text/html') ?? '';
  if (/<(?:h[1-6]|ul|ol|table|a\s|strong|em|b|i|pre|blockquote|img)\b/i.test(html)) return false;
  if (!looksLikeMarkdown(plain)) return false;
  event.preventDefault();
  // The clipboard gets the same safety checks as a loaded file: Markdown
  // the editor cannot represent faithfully goes in as literal text.
  const codec = richMarkdownCodecFor(editor.schema, editor.markdown!);
  if (richMarkdownBodySupport(plain).ok && checkRichMarkdownRoundTrip(codec, plain).ok) {
    return editor.chain().focus().insertContent(plain, { contentType: 'markdown' }).run();
  }
  // One paragraph per line; empty lines stay as empty paragraphs.
  const lines = plain.split(/\r\n?|\n/);
  return editor
    .chain()
    .focus()
    .insertContent(
      lines.map((line) =>
        line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
      )
    )
    .run();
}
