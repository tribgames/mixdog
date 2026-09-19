// Name aliases the operation contracts accept for fields, properties and
// operations whose spelling drifted between formats.

// A caller names a field with the word the snapshot uses for it. Where the
// reading and writing names differ for the same thing, the operation takes
// both rather than charging a round trip for the spelling.
export const FIELD_ALIASES = Object.freeze({
  // A link target is url in this runtime's PDF operations and address in the
  // Office ones, because each surface kept its own vocabulary. Both names
  // reach the same field instead of costing a round trip.
  docx: { add_comment: { anchoredText: 'find' }, add_hyperlink: { url: 'address' } },
  xlsx: { set_hyperlink: { url: 'address' } },
  // align_shapes takes align and distribute_shapes takes direction: the same
  // gesture, named after two different things. The word the operation is called
  // by reaches its field too.
  pptx: { set_hyperlink: { url: 'address' }, distribute_shapes: { distribute: 'direction' } },
});

// Font keys drifted apart between property sets of the same format: a Word run
// takes name / size / nameEastAsia while a table takes fontName / fontSize /
// fontNameEastAsia, and a worksheet cell takes the font- spelling. Each written
// name reaches the key its operation declares, in whichever direction.
// Only the font- spellings travel: they can mean nothing else. A bare name or
// size stays a question the operation answers with its own key list, since a
// table's name is not its font.
export const PROPERTY_ALIASES = Object.freeze({
  fontName: 'name',
  fontSize: 'size',
  fontNameEastAsia: 'nameEastAsia',
  nameEastAsia: 'fontNameEastAsia',
});

// The same act carries different names across this runtime's own formats: a
// link is add_hyperlink in Word, set_hyperlink in Excel and PowerPoint, and
// add_link in PDF. That drift is ours, so the caller's reasonable name reaches
// the operation instead of costing a round trip and a rewritten batch.
export const OPERATION_ALIASES = Object.freeze({
  docx: {
    add_paragraph: 'append_text',
    insert_paragraph: 'append_text',
    add_text: 'append_text',
    add_link: 'add_hyperlink',
    set_hyperlink: 'add_hyperlink',
    add_footnote: 'add_note',
  },
  xlsx: {
    add_row: 'append_row',
    add_link: 'set_hyperlink',
    add_hyperlink: 'set_hyperlink',
  },
  pptx: {
    add_link: 'set_hyperlink',
    add_hyperlink: 'set_hyperlink',
    add_notes: 'set_notes',
    set_note: 'set_notes',
  },
  pdf: {
    add_hyperlink: 'add_link',
    set_hyperlink: 'add_link',
  },
});
