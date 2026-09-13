import { plainObject } from '../shared/values.mjs';

const ACCEPTED = 'table: [[…], […]] or table: { headers: […], rows: [[…]] }';

function rowArrays(value) {
  if (!Array.isArray(value)) return null;
  return value.every((row) => Array.isArray(row)) ? value : null;
}

// One reading of a preset table for every consumer: the composer that writes
// the rows and the topology that picks the layout from them. A shape nobody
// can write is refused here rather than dropped, because a silently missing
// table reads as a finished document.
export function composeTableRows(table, { field = 'section.table', strict = true } = {}) {
  const refuse = (detail) => {
    if (!strict) return [];
    throw new Error(`${field} ${detail}. Pass ${ACCEPTED}.`);
  };
  if (table == null) return [];
  if (Array.isArray(table)) {
    return rowArrays(table) || refuse('must hold row arrays');
  }
  if (plainObject(table)) {
    const unusable = Object.keys(table).filter((key) => !['headers', 'rows'].includes(key));
    if (unusable.length) return refuse(`does not take ${unusable.join(', ')}`);
    const rows = rowArrays(table.rows ?? []);
    if (!rows) return refuse('rows must be an array of row arrays');
    const headers = Array.isArray(table.headers) && table.headers.length ? [table.headers] : [];
    if (!headers.length && !rows.length) return refuse('carries no rows');
    return [...headers, ...rows];
  }
  return refuse('must hold row arrays');
}
