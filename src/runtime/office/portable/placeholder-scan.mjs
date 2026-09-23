import { TEMPLATE_TOKEN_SOURCE } from './portable-xml.mjs';

// Wording only a template or a tool leaves behind; a deliverable never carries
// it. One list serves every format with visible text: slides, a document's
// body, headers and footers, and the pages of a PDF.
const PLACEHOLDER_RULES = Object.freeze([
  { code: 'placeholder_text', label: 'lorem ipsum filler', pattern: /\b(?:lorem|ipsum)\b/i },
  { code: 'placeholder_text', label: 'repeated X placeholder', pattern: /\bx{3,}\b/i },
  { code: 'placeholder_text', label: 'TODO marker', pattern: /\bTODO\b/ },
  { code: 'placeholder_text', label: 'insert marker', pattern: /\[\s*insert\b/i },
  {
    code: 'placeholder_text',
    label: 'layout instruction',
    pattern: /this[^.]{0,40}\b(?:page|slide)\b[^.]{0,40}layout/i,
  },
  { code: 'placeholder_text', label: 'click-to-edit prompt', pattern: /click to (?:edit|add)/i },
  { code: 'placeholder_text', label: 'Korean input prompt', pattern: /(?:여기에|내용을|제목을)\s*입력/ },
  // A value that reached the page as an object: no author types this, and it
  // shipped as a slide title while the measured read reported only the overlap
  // the oversized string caused. Bracketed forms only — "undefined" and "NaN"
  // are words a technical document may mean.
  { code: 'placeholder_text', label: 'stringified value', pattern: /\[object [A-Z]\w*\]/ },
  // A search or file tool's citation marker copied into the copy instead of a
  // readable source: the reader meets brackets and ids, never the reference.
  {
    code: 'placeholder_text',
    label: 'tool citation token',
    pattern: /【[^】\n]{0,80}†[^】\n]{0,80}】|turn\d+(?:search|view|news|image|file|fetch|product)\d+|[\uE200-\uE206]|<\/?cite\b[^>]*>/u,
  },
  { code: 'unfilled_token', label: 'unresolved template token', pattern: new RegExp(TEMPLATE_TOKEN_SOURCE, 'u') },
]);

/** One warning per rule the text trips, anchored at `path`. */
export function placeholderTextIssues(text, path, extra = {}) {
  const issues = [];
  if (!String(text || '').trim()) return issues;
  for (const rule of PLACEHOLDER_RULES) {
    const found = rule.pattern.exec(text);
    if (!found) continue;
    issues.push({
      severity: 'warning',
      code: rule.code,
      path,
      ...extra,
      message: `Leftover ${rule.label}: "${found[0].slice(0, 60)}"`,
      source: 'placeholder-scan',
    });
  }
  return issues;
}
