import { reviewDocxStructure } from './assurance-structure-docx.mjs';
import { reviewPptxStructure } from './assurance-structure-pptx.mjs';
import { reviewXlsxStructure } from './assurance-structure-xlsx.mjs';

export { issue } from './assurance-issue.mjs';

export function reviewOfficeStructure({ format, document, auditProfile = '' } = {}) {
  const normalized = String(format || document?.format || '').toLowerCase();
  if (normalized === 'docx') return reviewDocxStructure(document);
  if (normalized === 'xlsx') return reviewXlsxStructure(document, auditProfile);
  if (normalized === 'pptx') return reviewPptxStructure(document, auditProfile);
  return [];
}
