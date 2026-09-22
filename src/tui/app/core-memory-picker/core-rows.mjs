// core-memory-picker/core-rows.mjs
// The one core-memory read both panels issue, plus the row shapes built from
// it. `project_id: '*'` is the cross-project listing; `silent` keeps the read
// out of the transcript. A store without memoryControl short-circuits to
// undefined, exactly as the inline optional call did: the caller chains with
// `?.then(...)` and the loading frame simply stays.
export const loadCoreRows = ({ store, parseMemoryCoreRows }) =>
  store
    .memoryControl?.({ action: 'core', op: 'list', project_id: '*' }, { silent: true })
    .then((result) => parseMemoryCoreRows(result));

/** Footer for a highlighted entry row: the full, untruncated sentence. */
export const entrySummaryFooter = (item) =>
  item && item._action === 'core-entry' ? item._summary || item._element || '' : '';

/** The two rows of the Memory root panel: add, and the list with its count. */
export const rootRows = (coreRows) => [
  {
    value: 'core-add',
    label: 'Add Memory',
    description: 'store a new curated memory sentence',
    _action: 'add-core',
  },
  {
    value: 'core-list',
    label: 'Memory List',
    meta: coreRows.length ? String(coreRows.length) : '',
    description: coreRows.length ? 'open stored memories for edit/delete' : 'no stored memories',
    _action: 'core-list',
    _rows: coreRows,
  },
];
