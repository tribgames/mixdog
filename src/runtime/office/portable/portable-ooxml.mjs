import { applyDocx } from './portable-docx.mjs';
import { loadPackage, savePackage } from './portable-opc.mjs';
import { applyPptx } from './portable-pptx.mjs';
import { removeOrphanPackageParts } from './portable-validation.mjs';
import { applyXlsx } from './portable-xlsx.mjs';

export { imagePixelSize } from './portable-opc.mjs';
export { replaceAcrossRuns } from './portable-xml.mjs';
export { snapshotPortableOoxml } from './portable-snapshot.mjs';
export { inspectPptxTextBoxes } from './portable-pptx.mjs';
export { clearPortablePresentationSlides } from './portable-pptx-package.mjs';
export {
  issuesPortableOoxml,
  removeOrphanPackageParts,
  validatePortableOoxml,
} from './portable-validation.mjs';
export {
  recalculateLibreOfficeWorkbook,
  renderPortableOoxml,
  validateLibreOfficeReopen,
} from './portable-soffice.mjs';

export async function applyPortableOoxmlBatch(path, format, operations) {
  const zip = await loadPackage(path);
  const results = format === 'docx'
    ? await applyDocx(zip, operations)
    : format === 'xlsx'
      ? await applyXlsx(zip, operations)
      : await applyPptx(zip, operations);
  if (operations.some((operation) => ['delete_slide', 'replace_image', 'delete_shape'].includes(operation.op))) {
    await removeOrphanPackageParts(zip).catch(() => ({ removed: [] }));
  }
  await savePackage(zip, path);
  return results;
}
