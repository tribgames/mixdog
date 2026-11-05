// Legacy loader for the session-log tests: strict JSON, lifecycle defaults.
// A document carrying `unstableLoad` loads differently every time, which is
// how a base that cannot be proven equal to its legacy load is produced.
let loads = 0;

export function loadLegacy(text, sessionId) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || doc.id !== sessionId) return null;
  if (typeof doc.generation !== 'number') doc.generation = 0;
  if (typeof doc.closed !== 'boolean') doc.closed = false;
  if (!Array.isArray(doc.messages)) doc.messages = [];
  if (doc.unstableLoad) doc.loadNumber = ++loads;
  return doc;
}
