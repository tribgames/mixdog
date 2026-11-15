// How the Office recorders describe a file whose bytes two correct writers never share (the PDF writer, the PNG encoder, the deflate of
// a zip). One rule, used by record-office-dispatch.mjs and record-office-e2e.mjs; the replays (tests/support/file_view.rs of the
// mixdog-office crate) apply the same rule.
//  - a PDF by what a reader finds in it: per page its size and the text items (text, x, top, width, height, positions to the thousandth
//    of a point) and the fields of a form; with `properties` also the document properties without the dates (title, author, subject,
//    keywords, creator, producer; where the writer names itself, as pdf-lib does in Producer and, when none is set, Creator, the
//    mark is `<writer>`: the Rust writer names itself otherwise, and what a caller set is still compared);
//  - a PNG by its width, height and the sha256 of its decoded 8-bit RGBA pixels.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importFrom } from './common.mjs';

const OFFICE = 'src/runtime/office';
const WRITER = 'pdf-lib (https://github.com/Hopding/pdf-lib)';
const named = (value) => (value === undefined || value === null ? null : value === WRITER ? '<writer>' : value);
export const roundMilli = (value) => Math.floor(value * 1000 + 0.5) / 1000;
export const isPdf = (bytes) => bytes.length > 4 && bytes.subarray(0, 5).toString('latin1') === '%PDF-';
export const isPng = (bytes) => bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

export async function createOfficeFileReader(tree) {
  const requireFromTree = createRequire(path.join(tree, 'package.json'));
  const { PDFDocument } = requireFromTree('pdf-lib');
  const sharp = requireFromTree('sharp');
  const analysis = await importFrom(tree, `${OFFICE}/pdf/pdf-analysis.mjs`);
  const forms = await importFrom(tree, `${OFFICE}/pdf/pdf-forms.mjs`);

  async function pdfFingerprint(bytes, { properties = false } = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), 'office-pdf-'));
    const file = path.join(directory, 'read.pdf');
    try {
      writeFileSync(file, bytes);
      const layout = await analysis.extractPdfTextLayout(file, { shapes: false });
      const pages = layout.pages.map((page) => ({
        width: roundMilli(page.width),
        height: roundMilli(page.height),
        items: page.items.map((item) => ({ text: item.text, x: roundMilli(item.x), top: roundMilli(item.top), width: roundMilli(item.width), height: roundMilli(item.height) })),
      }));
      const document = await PDFDocument.load(bytes);
      const fields = document.getForm().getFields().map((field, index) => forms.describeFormField(field, document, index));
      const held = properties
        ? {
            properties: {
              title: document.getTitle() ?? null,
              author: document.getAuthor() ?? null,
              subject: document.getSubject() ?? null,
              keywords: document.getKeywords() ?? null,
              creator: named(document.getCreator()),
              producer: named(document.getProducer()),
            },
          }
        : {};
      return { pdf: { pages, ...(fields.length ? { fields } : {}), ...held } };
    } catch (error) {
      return { pdf: { unreadable: String(error?.message ?? error) } };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async function pngFingerprint(bytes) {
    try {
      const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { png: { width: info.width, height: info.height, sha256: createHash('sha256').update(data).digest('hex') } };
    } catch {
      return { png: { unreadable: true } };
    }
  }

  return { pdfFingerprint, pngFingerprint };
}
