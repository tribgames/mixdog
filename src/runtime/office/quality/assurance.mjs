// Office assurance reviews, split by concern. This facade keeps the public surface
// stable for the runtime, benchmarks, and scripts/office-design-audit.mjs.
export {
  analyzeOfficeFilePromptInjection,
  analyzeOfficePromptInjection,
  assertOfficeMutationAllowed,
  combineOfficeTrustReviews,
} from './assurance-trust.mjs';
export { reviewOfficeStructure } from './assurance-structure.mjs';
export { reviewRenderedOfficePages } from './assurance-rendered.mjs';
export { evaluateOfficeChecklist } from './assurance-checklist.mjs';
