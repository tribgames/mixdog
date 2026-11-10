// What differs between several recordings of Node's phone-terminal trace. `order` and `claims.order` are each compared as: the entries that
// are not terminal data, in sequence; and, per tab, the slots (the index of the last non-data entry before them) that carried data and the
// bytes the slot carried.
const isData = (entry) => entry.push === 'termData';

/** Per tab: slot -> concatenated data, for one ordered list. */
export function slotsOf(list) {
  const slots = {};
  let slot = -1;
  for (const entry of list) {
    if (!isData(entry)) {
      slot += 1;
      continue;
    }
    const { id, data } = entry.event;
    slots[id] ??= {};
    slots[id][slot] = (slots[id][slot] ?? '') + data;
  }
  return slots;
}

export function varianceReport(traces) {
  const report = {};
  for (const part of ['order', 'claims.order']) {
    const lists = traces.map((trace) => part.split('.').reduce((value, key) => value[key], trace));
    const kept = lists.map((list) => list.filter((entry) => !isData(entry)));
    const sequences = new Set(kept.map((list) => JSON.stringify(list)));
    const slots = lists.map(slotsOf);
    const tabs = [...new Set(slots.flatMap((s) => Object.keys(s)))].sort();
    const perTab = {};
    for (const tab of tabs) {
      const all = [...new Set(slots.flatMap((s) => Object.keys(s[tab] ?? {})))].map(Number).sort((a, b) => a - b);
      const present = (s, at) => (s[tab]?.[at] !== undefined ? 1 : 0);
      perTab[tab] = {
        slotsWithData: all.length,
        slotsWhereDataPresenceDiffers: all.filter((at) => new Set(slots.map((s) => present(s, at))).size > 1),
        slotsWhereBytesDiffer: all.filter((at) => new Set(slots.map((s) => s[tab]?.[at] ?? null)).size > 1).length,
        concatenatedBytesDistinct: new Set(slots.map((s) => Object.values(s[tab] ?? {}).join(''))).size,
      };
    }
    report[part] = {
      entries: lists.map((list) => list.length),
      entriesWithoutData: kept.map((list) => list.length),
      distinctSequencesWithoutData: sequences.size,
      // What follows the last dispose answer in each run: Node's killed shells read late output after the dispose, so some runs hold a
      // `running` then an end of activity for a disposed tab there and some none (the rule the comparison applies to that stretch).
      afterLastDispose: kept.map((list) =>
        list.slice(list.map((e) => e.call).lastIndexOf('termDispose') + 1).map((e) => (e.lane ? `lane ${e.lane} ${e.on}` : e.event ? `${e.event.id} ${e.event.state}` : e.call))
      ),
      perTab,
    };
  }
  return report;
}

