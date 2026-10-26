// The attachments a session's whole stored conversation names (its record and
// its compaction archive), reduced to the metadata that says which rows name
// which attachment. Whether an attachment id belongs to a session is decided
// against this, not against a transcript window (a tail plus the pages paged
// in), which no longer holds rows a compaction moved into the archive.

const pick = (entry, keys) => Object.fromEntries(keys.filter((key) => entry?.[key] != null).map((key) => [key, entry[key]]));
const picked = (list, keys) => (Array.isArray(list) ? list.map((entry) => pick(entry, keys)) : []);

/** The rows of `items` that name attachments, reduced to the fields the
 *  desktop reads to attribute an id to its row: the row kind (and a notice's
 *  routine / room kind) and each attachment's id, name, type and size. No
 *  text, tool output or other row content is kept. */
export function attachmentHistoryRows(items) {
  const rows = [];
  for (const item of Array.isArray(items) ? items : []) {
    const attachments = picked(item?.attachments, ['id', 'name', 'mimeType', 'kind', 'size']);
    const images = picked(item?.images, ['attachmentRef', 'name', 'mimeType', 'bytes']);
    const imageRefs = picked(item?.imageRefs, ['ref']);
    if (!attachments.length && !images.length && !imageRefs.length) continue;
    rows.push({
      kind: item.kind,
      ...(item.routine?.kind ? { routine: { kind: item.routine.kind } } : {}),
      ...(item.room?.kind ? { room: { kind: item.room.kind } } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(images.length ? { images } : {}),
      ...(imageRefs.length ? { imageRefs } : {}),
    });
  }
  return rows;
}
