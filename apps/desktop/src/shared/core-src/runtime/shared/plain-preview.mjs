// A messenger preview line reads as plain text, as KakaoTalk shows it: the
// markdown a reply was written in (bold, headings, list markers, quotes,
// code fences and spans, links, images) is dropped, its words kept.

/** `text` without markdown syntax, whitespace folded to single spaces. */
export function plainPreviewText(text) {
  // HTML comments never show in markdown (a greeting's suggestions ride one).
  return (
    String(text ?? '')
      .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
      .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, ' ')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/`+([^`\n]*)`+/g, '$1')
      .replace(/\s+/g, ' ')
      // A summary stored before newlines were kept already folded its list: a
      // dash or bullet right after a sentence end is a marker, not a hyphen.
      .replace(/([.!?。…:：])\s[-*+•]\s+(?=\S)/g, '$1 ')
      .trim()
      .slice(0, PREVIEW_CAP)
  );
}

/** A safety cap only: the row clamps the shown text to two lines. */
const PREVIEW_CAP = 200;
