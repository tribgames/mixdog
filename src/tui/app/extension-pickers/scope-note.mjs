// extension-pickers/scope-note.mjs
// Project scope from a decorated status row (resource-api scopeInfo): '' when
// global, else a short note. Editing lives in Desktop / setup tool.
export const scopeNote = (row) => {
  if (row?.activeHere === false) return 'not in this project';
  const own = Array.isArray(row?.scope) ? row.scope.length : 0;
  const inherited = Array.isArray(row?.inheritedScope) ? row.inheritedScope.length : 0;
  const count = own || inherited;
  if (!count) return '';
  return count === 1 ? '1 project' : `${count} projects`;
};

export const withScope = (text, row) => {
  const note = scopeNote(row);
  return note ? `${text} · ${note}` : text;
};

/** Reads one daemon status list; a failure is reported and yields null so the
 *  caller paints nothing (the sync versions handed every picker an unresolved
 *  promise, i.e. empty lists). */
export async function readStatus(store, method, key, failureLabel) {
  let status;
  try {
    status = (await store[method]?.()) || { [key]: [] };
  } catch (e) {
    store.pushNotice(`${failureLabel} failed: ${e?.message || e}`, 'error');
    return null;
  }
  return { ...status, [key]: status[key] || [] };
}
