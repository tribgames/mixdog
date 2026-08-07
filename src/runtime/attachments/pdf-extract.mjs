/**
 * Bounded PDF inspection/text extraction shared by prompt intake and `read`.
 *
 * Native PDF-capable providers receive the original content-addressed file.
 * OpenAI-compatible providers without a document contract receive page-ordered
 * text extracted here, so they never see an unsupported inline Base64 block.
 */
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function boundedUtf8(value, maxBytes) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), bytes: buffer.length, truncated: false };
  if (maxBytes <= 0) return { text: '', bytes: 0, truncated: true };
  const text = buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/g, '');
  return { text, bytes: Buffer.byteLength(text, 'utf8'), truncated: true };
}

export async function inspectPdfBuffer(buffer, {
  extractText = false,
  maxPages = DEFAULT_MAX_PAGES,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  pageRange = null,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new TypeError('PDF payload is empty');
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const pageCount = Math.max(0, Number(pdf?.numPages) || 0);
    const pageLimit = Number.isFinite(Number(maxPages)) ? Math.max(1, Math.floor(Number(maxPages))) : Infinity;
    if (pageCount > pageLimit) {
      throw new RangeError(`PDF has ${pageCount} pages; maximum supported attachment is ${pageLimit} pages`);
    }
    if (!extractText) return { pageCount, text: '', truncated: false };

    const from = Math.max(1, Number(pageRange?.from) || 1);
    const to = Math.min(pageCount, Math.max(from, Number(pageRange?.to) || pageCount));
    const byteLimit = Math.max(1, Number(maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES);
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    for (let pageNumber = from; pageNumber <= to; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const body = (content?.items || [])
          .map((item) => typeof item?.str === 'string' ? item.str : '')
          .filter(Boolean)
          .join(' ')
          .trim();
        const block = `--- Page ${pageNumber} ---\n${body || '(no extractable text on this page)'}`;
        const separatorBytes = chunks.length ? 2 : 0;
        const remaining = byteLimit - bytes - separatorBytes;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const bounded = boundedUtf8(block, remaining);
        if (chunks.length) {
          chunks.push('\n\n');
          bytes += 2;
        }
        chunks.push(bounded.text);
        bytes += bounded.bytes;
        if (bounded.truncated) {
          truncated = true;
          break;
        }
      } finally {
        try { page.cleanup?.(); } catch {}
      }
    }
    if (truncated) {
      const suffix = '\n\n... [PDF text truncated to the prompt input budget]';
      const room = Math.max(0, byteLimit - Buffer.byteLength(suffix, 'utf8'));
      const bounded = boundedUtf8(chunks.join(''), room);
      return { pageCount, text: `${bounded.text}${suffix}`, truncated: true };
    }
    return { pageCount, text: chunks.join(''), truncated: false };
  } finally {
    try { await pdf.destroy?.(); } catch {}
  }
}
