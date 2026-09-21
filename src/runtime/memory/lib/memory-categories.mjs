// The memory category vocabulary, shared by recall filters, the curated core
// store, the manage actions and the score table. Side-effect free so callers
// that must not pull in the database layer can still validate a category.
export const VALID_CATEGORY = new Set([
  'rule',
  'constraint',
  'decision',
  'fact',
  'goal',
  'preference',
  'task',
  'issue',
]);
