import { snapshotPortableOoxml } from '../../portable/portable-ooxml.mjs';
import { annotatePptxSnapshotRoles } from './design-template-induct.mjs';

// Reusing a deck means putting a message on the page whose structure already
// carries it. The page is chosen by the job it does, and its boxes are filled by
// the slot each one holds, so the template keeps its own design and only its
// words change. The work happens before the batch reaches a backend: the page
// arrives through import_slides and its boxes are written with set_text, both of
// which Microsoft Office and the portable writer already do.

const GROUP_ROLE = /^(column|metric|step)-(title|body|value|label|detail)-(\d+)$/;
// What the two lines of one item are called in each structure.
const GROUP_FIELDS = Object.freeze({
  column: { lead: 'title', follow: 'body' },
  metric: { lead: 'value', follow: 'label' },
  step: { lead: 'title', follow: 'detail' },
});

function pageSlots(page) {
  const slots = new Map();
  for (const shape of page?.shapes || []) {
    if (shape.slot && Number(shape.index) > 0) slots.set(String(shape.slot), Number(shape.index));
  }
  return slots;
}

// The page's repeated structure and how many items it holds: the capacity the
// content has to fit, since a page takes one more item by being replaced, never
// by shrinking its type.
function pageGroup(slots) {
  const sizes = new Map();
  for (const role of slots.keys()) {
    const match = GROUP_ROLE.exec(role);
    if (!match) continue;
    sizes.set(match[1], Math.max(sizes.get(match[1]) || 0, Number(match[3])));
  }
  const [family, size] = [...sizes.entries()].sort((left, right) => right[1] - left[1])[0] || [];
  return family ? { family, size, ...GROUP_FIELDS[family] } : null;
}

export function selectTemplatePage(document, request) {
  const pages = Array.isArray(document?.slides) ? document.slides : [];
  if (Number.isInteger(request?.slide)) {
    const page = pages[request.slide - 1];
    if (!page) throw new Error(`The template has no slide ${request.slide}; it holds ${pages.length}`);
    return page;
  }
  const role = String(request?.role || '');
  if (!role)
    throw new Error('use_template_page needs the page to use: role for the job it does, or slide for one exact page');
  const matches = pages.filter((page) => String(page.role || '') === role);
  if (!matches.length) {
    const carried = [...new Set(pages.map((page) => String(page.role || '')).filter(Boolean))].join(', ');
    throw new Error(`The template carries no ${role} page; its pages are: ${carried || 'unread'}`);
  }
  const items = Array.isArray(request?.items) ? request.items.length : 0;
  const sized = matches.map((page) => ({ page, size: pageGroup(pageSlots(page))?.size || 0 }));
  // The page that takes the items with the least room left over; when none holds
  // them the widest one answers and the fill reports how far it falls short.
  const fits = sized.filter((entry) => entry.size >= items);
  const chosen = fits.length
    ? fits.sort((left, right) => left.size - right.size)[0]
    : sized.sort((left, right) => right.size - left.size)[0];
  return chosen.page;
}

// Places each item's lead and follow text in the group's slots. Fewer items
// than slots empties the unused ones outright: the template's own words are
// never left behind to read as content. Text with no box is reported, not dropped.
function placeGroupItems(slots, group, items) {
  const sets = [];
  const deletes = [];
  const unplaced = [];
  for (let position = 1; group && position <= group.size; position += 1) {
    const item = items[position - 1];
    const lead = slots.get(`${group.family}-${group.lead}-${position}`);
    const follow = slots.get(`${group.family}-${group.follow}-${position}`);
    const leadText = String(item?.title ?? item?.value ?? '');
    const followText = String(item?.body ?? item?.label ?? item?.detail ?? '');
    if (lead) {
      if (leadText) sets.push({ shape: lead, text: leadText });
      else deletes.push(lead);
    } else if (leadText) unplaced.push({ position, field: group.lead });
    if (follow) {
      if (followText) sets.push({ shape: follow, text: followText });
      else deletes.push(follow);
    } else if (followText) unplaced.push({ position, field: group.follow });
  }
  return { sets, deletes, unplaced };
}

function unplacedTextError(page, group, unplaced) {
  const fields = [...new Set(unplaced.map((entry) => entry.field))].join(' and ');
  const positions = [...new Set(unplaced.map((entry) => entry.position))].join(', ');
  return new Error(
    `Slide ${page.index} of the template has no ${group.family} ${fields} box for item ${positions}, so that text has nowhere to go: put it in the item's ${group.lead}, or use a page whose ${group.family}s carry a ${fields} line`
  );
}

export function templatePageFill(page, content) {
  const slots = pageSlots(page);
  const group = pageGroup(slots);
  const items = Array.isArray(content?.items) ? content.items : [];
  if (items.length && !group) {
    throw new Error(
      `Slide ${page.index} of the template carries no repeated group, so its ${items.length} items have nowhere to go`
    );
  }
  if (group && items.length > group.size) {
    throw new Error(
      `Slide ${page.index} of the template holds ${group.size} ${group.family} slots and ${items.length} items were given: split them across two pages, or use a page that holds more`
    );
  }
  const sets = [];
  const title = String(content?.title || '');
  if (title) {
    const shape = slots.get('title');
    if (!shape) throw new Error(`Slide ${page.index} of the template has no title slot to fill`);
    sets.push({ shape, text: title });
  }
  // Text an item carries that the page has no box for: a comparison page whose
  // columns are one line each cannot hold the second line of an item, and
  // writing the first line alone drops the rest without a word. A page that
  // cannot take the content says so, the way it does for too many items.
  const placed = placeGroupItems(slots, group, items);
  if (placed.unplaced.length) throw unplacedTextError(page, group, placed.unplaced);
  return {
    sets: [...sets, ...placed.sets],
    // Deleting a shape renumbers the ones after it, so they go highest first.
    deletes: [...new Set(placed.deletes)].sort((left, right) => right - left),
    group,
  };
}

export async function expandTemplatePageOperations(format, operations) {
  if (format !== 'pptx' || !operations.some((operation) => operation?.op === 'use_template_page')) return operations;
  const expanded = [];
  for (const operation of operations) {
    if (operation?.op !== 'use_template_page') {
      expanded.push(operation);
      continue;
    }
    const after = Number(operation.after);
    if (!Number.isInteger(after) || after < 0) {
      throw new Error(
        'use_template_page needs after: the slide the new page follows, 0 to put it at the front of the deck'
      );
    }
    const document = annotatePptxSnapshotRoles(await snapshotPortableOoxml(operation.path, 'pptx'));
    const page = selectTemplatePage(document, operation);
    const { sets, deletes } = templatePageFill(page, operation);
    const slide = after + 1;
    expanded.push({ op: 'import_slides', path: operation.path, slides: [Number(page.index)], after });
    for (const entry of sets) expanded.push({ op: 'set_text', slide, shape: entry.shape, text: entry.text });
    for (const shape of deletes) expanded.push({ op: 'delete_shape', slide, shape });
    if (operation.notes) expanded.push({ op: 'set_notes', slide, text: String(operation.notes) });
  }
  return expanded;
}
