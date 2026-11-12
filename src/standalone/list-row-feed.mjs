// A whole list published again and again (the Agents pool, the sessions
// catalog: both rebuilt from a catalog scan) turned into per-row frames: the
// one place a publication is compared with the last, by row identity
// (wire.md "Global lists"). A frame upserts one row right after the row that
// precedes it in the new order (`after`, null: first), or removes one; applied
// in seq order to the last read they rebuild the published list exactly. The
// rows of a longest run that kept its relative order are not moved; every
// other row is framed in new order, so its predecessor is already in place.

let epochSeq = 0;

// The indexes (into `seqs`) of a longest strictly increasing subsequence: the
// rows that keep their relative order, which no frame needs to move.
function longestIncreasing(seqs) {
  const tails = [];
  const tailAt = [];
  const previous = new Array(seqs.length).fill(-1);
  for (let i = 0; i < seqs.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < seqs[i]) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = seqs[i];
    tailAt[lo] = i;
    previous[i] = lo > 0 ? tailAt[lo - 1] : -1;
  }
  const keep = new Set();
  for (let i = tails.length ? tailAt[tails.length - 1] : -1; i >= 0; i = previous[i]) keep.add(i);
  return keep;
}

/** `list`: the list's wire name; `idOf(row)`: its identity. */
export function createListRowFeed(list, idOf) {
  const epoch = `${process.pid.toString(36)}.${Date.now().toString(36)}.${(++epochSeq).toString(36)}`;
  let seq = 0;
  let ids = []; // published order
  let byId = new Map(); // id -> { row, json }

  return {
    /** The frames that take the last publication to `rows` (in order). */
    publish(rows) {
      const nextIds = [];
      const nextById = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = String(idOf(row) ?? '');
        if (!id || nextById.has(id)) continue;
        nextIds.push(id);
        nextById.set(id, { row, json: JSON.stringify(row) });
      }
      const frames = [];
      const working = ids.filter((id) => {
        if (nextById.has(id)) return true;
        frames.push({ kind: 'list-row', list, epoch, seq: ++seq, id, removed: true });
        return false;
      });
      const at = new Map(working.map((id, i) => [id, i]));
      const surviving = nextIds.filter((id) => at.has(id));
      const kept = longestIncreasing(surviving.map((id) => at.get(id)));
      const stays = new Set(surviving.filter((_, i) => kept.has(i)));
      nextIds.forEach((id, index) => {
        const next = nextById.get(id);
        if (stays.has(id) && byId.get(id).json === next.json) return;
        const after = index > 0 ? nextIds[index - 1] : null;
        frames.push({ kind: 'list-row', list, epoch, seq: ++seq, id, after, row: next.row });
      });
      ids = nextIds;
      byId = nextById;
      return frames;
    },
    /** The last publication with the seq of the last frame it contains. */
    read() {
      return { list, epoch, seq, rows: ids.map((id) => byId.get(id).row) };
    },
  };
}
