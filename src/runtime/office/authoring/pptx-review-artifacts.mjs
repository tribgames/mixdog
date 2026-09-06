import { snapshot } from '../core/office-sessions.mjs';
import { attachRenderedAir, compositionReceipt } from './pptx-receipt.mjs';
import { writeContactSheet } from './pptx-contact-sheet.mjs';
import { renderedAirByPage } from '../quality/render-air.mjs';

export async function readCompositionReceipt(session) {
  try {
    const current = await snapshot(session, { includeStyles: true, limit: 100, maxChars: 100_000 }, { full: true });
    return compositionReceipt(current?.document, session.authoredBrief);
  } catch {
    return null;
  }
}

// Author and standalone render expose the same review artifacts; QA uses the
// raw page preview so contact sheets never enter pixel-level page checks.
export async function pptxReviewArtifacts(session, preview) {
  const result = { ...preview, _images: [...(preview._images || [])] };
  const receipt = await readCompositionReceipt(session);
  if (receipt) {
    const air = await renderedAirByPage(result._images).catch(() => null);
    if (air) attachRenderedAir(receipt, air);
    result.receipt = receipt;
  }
  const sheet = await writeContactSheet(result._images, preview.output).catch(() => null);
  if (sheet) {
    const { data, ...meta } = sheet;
    result.contactSheet = meta;
    result._images.push({ page: 0, ...meta, data });
  }
  return result;
}
