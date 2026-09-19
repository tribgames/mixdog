import { loadPackage } from './portable-opc.mjs';
import { snapshotDocx } from './portable-snapshot-docx.mjs';
import { snapshotXlsx } from './portable-snapshot-xlsx.mjs';
import { snapshotPptx } from './portable-snapshot-pptx.mjs';

export { appendDocxBlock, docxBodyModel, snapshotDocx } from './portable-snapshot-docx.mjs';
export { FULL_READ_CELL_LIMIT, snapshotXlsx } from './portable-snapshot-xlsx.mjs';
export { snapshotPptx } from './portable-snapshot-pptx.mjs';

export async function snapshotPortableOoxml(path, format, options = {}) {
  const zip = await loadPackage(path);
  if (format === 'docx') return await snapshotDocx(zip, options);
  if (format === 'xlsx') return await snapshotXlsx(zip, options);
  if (format === 'pptx') return await snapshotPptx(zip, options);
  throw new Error(`Unsupported OOXML format: ${format}`);
}
