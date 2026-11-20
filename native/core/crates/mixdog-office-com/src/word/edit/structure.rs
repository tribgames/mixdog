//! The page and document structure operations of `Invoke-WordOperation`: `set_header_footer`, `insert_toc`,
//! `add_page_numbers`, `insert_break`, `add_hyperlink`, `add_bookmark`, `set_content_control`, `add_note` and `set_page`.

use super::Com;
use super::Para;
use super::Value;
use super::append;
use super::cast_int;
use super::cast_single;
use super::color_of;
use super::flag;
use super::formatting;
use super::lists;
use super::lower;
use super::ordered;
use super::prop;
use super::r4;
use super::same;
use super::tables::eq_false;
use super::text_of;
use super::truthy;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::ps::text;

/// `$doc.Sections.Item($(if ($op.section) { [int]$op.section } else { 1 }))`.
fn section_of(document: &Obj, op: &Value) -> Result<Com> {
    let sections = document.get("Sections")?;
    let at = if truthy(&prop(op, "section")) { cast_int(&prop(op, "section"))? } else { 1 };
    super::item(&sections, at)
}

/// `set_header_footer`: kind and variant name the story; an unknown name is refused rather than written into a default one.
pub(super) fn set_header_footer(document: &Obj, op: &Value) -> Result<Value> {
    let section = section_of(document, op)?;
    // kind names either the thing (header, footer) or the page variant.
    let named = lower(&text_of(&prop(op, "kind")));
    if !named.is_empty() && !["header", "footer", "default", "first", "even"].iter().any(|known| same(known, &named)) {
        return Err(Error::host("set_header_footer kind must be header, footer, default, first, or even"));
    }
    let mut variant = lower(&text_of(&prop(op, "variant")));
    if !variant.is_empty() && !["default", "first", "even"].iter().any(|known| same(known, &variant)) {
        return Err(Error::host("set_header_footer variant must be default, first, or even"));
    }
    if variant.is_empty() && ["default", "first", "even"].iter().any(|known| same(known, &named)) {
        variant = named.clone();
    }
    let kind = match variant.as_str() {
        "first" => 2,
        "even" => 3,
        _ => 1,
    };
    let header = prop(op, "header");
    let use_footer = if same(&named, "footer") {
        true
    } else if same(&named, "header") {
        false
    } else {
        !header.is_null() && !truthy(&header)
    };
    // The story is taken straight off the section: a COM collection handed through an if-expression is unrolled into an
    // array, and an array's Item(1) is its second element.
    let item = super::item(&section.member(if use_footer { "Footers" } else { "Headers" })?, kind)?;
    item.set_member("Exists", Com::Bool(true))?;
    item.member("Range")?.set_member("Text", Com::from(text_of(&prop(op, "text"))))?;
    // The running line in the author's type, as the portable writer sets it.
    let props = prop(op, "properties");
    if truthy(&props) {
        let range = item.member("Range")?;
        if truthy(&prop(&props, "name")) {
            formatting::set_latin_font(&range.member("Font")?, &text_of(&prop(&props, "name")))?;
        }
        if truthy(&prop(&props, "nameEastAsia")) {
            range.member("Font")?.set_member("NameFarEast", Com::from(text_of(&prop(&props, "nameEastAsia"))))?;
        }
        if truthy(&prop(&props, "size")) {
            range.member("Font")?.set_member("Size", r4(&prop(&props, "size"))?)?;
        }
        if !prop(&props, "bold").is_null() {
            range.member("Font")?.set_member("Bold", flag(&prop(&props, "bold"), -1))?;
        }
        if truthy(&prop(&props, "color")) {
            range.member("Font")?.set_member("Color", color_of(&prop(&props, "color"))?)?;
        }
        if truthy(&prop(&props, "alignment")) {
            let code = formatting::line_alignment(&prop(&props, "alignment"), "set_header_footer alignment")?;
            range.member("ParagraphFormat")?.set_member("Alignment", Com::I4(code))?;
        }
    }
    Ok(ordered(vec![
        ("op", Value::string("set_header_footer")),
        ("changed", Value::Bool(true)),
        ("section", super::ps_value(&section.member("Index")?, "System.Object")?),
        ("header", Value::Bool(!use_footer)),
        ("variant", Value::String(if variant.is_empty() { "default".to_owned() } else { variant })),
    ]))
}

/// `insert_toc`: the table lands where the batch has reached, in a paragraph of its own; it is rebuilt again when the
/// document is saved, once the headings exist.
pub(super) fn insert_toc(document: &Obj, op: &Value) -> Result<Value> {
    let paragraph = prop(op, "paragraph");
    let named = truthy(&paragraph) && cast_int(&paragraph)? != super::count_of(document)?;
    let toc_paragraph = if named {
        let anchor = super::item(&document.get("Paragraphs")?, cast_int(&paragraph)?)?.member("Range")?.member("Duplicate")?;
        anchor.call_member("Collapse", &[Com::I4(0)])?;
        let added = document.get("Paragraphs")?.call_member("Add", &[anchor])?;
        lists::reset_paragraph(&Para::Real(added.clone()))?;
        added
    } else {
        // At the end it takes the paragraph the next block would (Word-EndParagraph).
        let paragraphs = document.get("Paragraphs")?;
        let at = append::end_paragraph(document, false)?;
        super::item(&paragraphs, at)?
    };
    let range = toc_paragraph.member("Range")?.member("Duplicate")?;
    range.call_member("Collapse", &[Com::I4(1)])?;
    // The bounds of the levels listed, in either order and 1 to 3 unless given, as the portable writer reads them.
    let level = |name: &str, fallback: i32| -> Result<i32> {
        let given = prop(op, name);
        if truthy(&given) { cast_int(&given) } else { Ok(fallback) }
    };
    let first = level("lowerHeadingLevel", 1)?;
    let last = level("upperHeadingLevel", 3)?;
    let upper = 1_i32.max(first.min(last));
    let lower_level = 9_i32.min(first.max(last));
    let toc = document.get("TablesOfContents")?.call_member("Add", &[range, Com::Bool(true), Com::I4(upper), Com::I4(lower_level)])?;
    let _ = toc.call_member("Update", &[]);
    Ok(ordered(vec![
        ("op", Value::string("insert_toc")),
        ("changed", Value::Bool(true)),
        ("index", Value::Int(super::int(&toc.member("Index")?)?)),
        ("levels", Value::String(format!("{upper}-{lower_level}"))),
    ]))
}

/// `add_page_numbers`: PAGE and NUMPAGES fields in the footer, the number alone, a prefix only when asked for, and the total
/// with includeTotal:true or a separator.
pub(super) fn add_page_numbers(document: &Obj, op: &Value) -> Result<Value> {
    let section = section_of(document, op)?;
    let named = prop(op, "kind");
    let kind_text = text_of(&named);
    if !truthy(&named) {
        section.member("PageSetup")?.set_member("DifferentFirstPageHeaderFooter", Com::I4(0))?;
        section.member("PageSetup")?.set_member("OddAndEvenPagesHeaderFooter", Com::I4(0))?;
    } else if same(&kind_text, "first") {
        section.member("PageSetup")?.set_member("DifferentFirstPageHeaderFooter", Com::I4(-1))?;
    } else if same(&kind_text, "even") {
        section.member("PageSetup")?.set_member("OddAndEvenPagesHeaderFooter", Com::I4(-1))?;
    }
    let kind = if same(&kind_text, "first") {
        2
    } else if same(&kind_text, "even") {
        3
    } else {
        1
    };
    let footer = super::item(&section.member("Footers")?, kind)?;
    footer.set_member("Exists", Com::Bool(true))?;
    // A footer that already says something (a source line from set_header_footer) keeps it: the number takes a paragraph
    // of its own under it. An empty footer takes the number in its one paragraph.
    let said = !super::string(&footer.member("Range")?.member("Text")?).trim_matches(['\r', '\n', '\u{7}', ' ']).is_empty();
    if said {
        footer.member("Range")?.call_member("InsertParagraphAfter", &[])?;
    }
    let mut range = footer.member("Range")?.member("Paragraphs")?.member("Last")?.member("Range")?;
    if said {
        range.call_member("MoveEnd", &[Com::I4(1), Com::I4(-1)])?;
    } else {
        range = footer.member("Range")?;
    }
    let prefix = prop(op, "prefix");
    range.set_member("Text", Com::from(if truthy(&prefix) { format!("{} ", text_of(&prefix)) } else { String::new() }))?;
    let at_end = |footer: &Com| -> Result<Com> {
        let end = footer.member("Range")?;
        end.call_member("Collapse", &[Com::I4(0)])?;
        Ok(end)
    };
    let end = at_end(&footer)?;
    footer.member("Range")?.member("Fields")?.call_member("Add", &[end, Com::I4(-1), Com::from("PAGE"), Com::Bool(true)])?;
    let separator = text_of(&prop(op, "separator")).trim().to_owned();
    let include_total = truthy(&prop(op, "includeTotal")) || (!eq_false(&prop(op, "includeTotal")) && !separator.is_empty());
    if include_total {
        let end = at_end(&footer)?;
        end.call_member("InsertAfter", &[Com::from(format!(" {} ", if separator.is_empty() { "/" } else { separator.as_str() }))])?;
        let end = at_end(&footer)?;
        footer.member("Range")?.member("Fields")?.call_member("Add", &[end, Com::I4(-1), Com::from("NUMPAGES"), Com::Bool(true)])?;
    }
    let number_line = footer.member("Range")?.member("Paragraphs")?.member("Last")?.member("Range")?;
    let alignment = match lower(&text_of(&prop(op, "alignment"))).as_str() {
        "left" => 0,
        "right" => 2,
        _ => 1,
    };
    number_line.member("ParagraphFormat")?.set_member("Alignment", Com::I4(alignment))?;
    // The number reads in the Normal faces at 9 pt.
    let _ = (|| -> Result<()> {
        let normal_font = super::item(&document.get("Styles")?, -1)?.member("Font")?;
        if super::truth(&normal_font.member("Name")?) {
            number_line.member("Font")?.set_member("Name", Com::from(super::string(&normal_font.member("Name")?)))?;
        }
        if super::truth(&normal_font.member("NameFarEast")?) {
            number_line.member("Font")?.set_member("NameFarEast", Com::from(super::string(&normal_font.member("NameFarEast")?)))?;
        }
        number_line.member("Font")?.set_member("Size", Com::I4(9))?;
        // The number's own ink, not the colour of the footer line it was split from (wdColorAutomatic).
        if said {
            number_line.member("Font")?.set_member("Color", Com::I4(-16_777_216))?;
        }
        Ok(())
    })();
    Ok(ordered(vec![
        ("op", Value::string("add_page_numbers")),
        ("changed", Value::Bool(true)),
        ("section", Value::Int(super::int(&section.member("Index")?)?)),
    ]))
}

/// What is left of a paragraph's text once the marks and breaks are taken out.
fn bare_text(text: &str, with_form_feed: bool) -> String {
    text.chars().filter(|letter| !matches!(letter, '\r' | '\u{7}' | '\u{b}' | '\u{e}') && !(with_form_feed && *letter == '\u{c}')).collect()
}

/// `insert_break`: at the end the break takes a paragraph of its own (Word-EndParagraph), as the portable writer writes it.
pub(super) fn insert_break(document: &Obj, op: &Value) -> Result<Value> {
    let named = truthy(&prop(op, "paragraph"));
    let range = if named {
        super::item(&document.get("Paragraphs")?, cast_int(&prop(op, "paragraph"))?)?.member("Range")?.member("Duplicate")?
    } else {
        let paragraphs = document.get("Paragraphs")?;
        let at = append::end_paragraph(document, false)?;
        super::item(&paragraphs, at)?.member("Range")?.member("Duplicate")?
    };
    range.call_member("Collapse", &[Com::I4(if named { 0 } else { 1 })])?;
    // A column break is wdColumnBreak (8): it was written as a page break, where the portable writer breaks the column.
    let break_type = match lower(&text_of(&prop(op, "kind"))).as_str() {
        "section_next" => 2,
        "section_continuous" => 3,
        "column" => 8,
        _ => 7,
    };
    range.call_member("InsertBreak", &[Com::I4(break_type)])?;
    // Word opens the break's own paragraph at the start of the next one, in that paragraph's style: the break stands in a
    // plain Normal paragraph, as the portable writer writes it.
    if named && (break_type == 7 || break_type == 8) {
        let next = cast_int(&prop(op, "paragraph"))? + 1;
        let mut holder = super::item(&document.get("Paragraphs")?, next)?;
        let holder_text = |holder: &Com| -> Result<String> { Ok(super::string(&holder.member("Range")?.member("Text")?)) };
        // A column break goes in at the start of the next paragraph's own line rather than on one of its own; a paragraph
        // mark after it gives it one, as a page break gets.
        if break_type == 8 && !bare_text(&holder_text(&holder)?, false).is_empty() {
            let start = super::int(&holder.member("Range")?.member("Start")?)? + 1;
            let end = super::int(&holder.member("Range")?.member("Start")?)? + 1;
            super::document_range(document, start, end)?.call_member("InsertAfter", &[Com::from("\r")])?;
            holder = super::item(&document.get("Paragraphs")?, cast_int(&prop(op, "paragraph"))? + 1)?;
        }
        if bare_text(&holder_text(&holder)?, true).is_empty() {
            holder.member("Range")?.set_member("Style", Com::I4(-1))?;
            holder.member("Range")?.member("ParagraphFormat")?.call_member("Reset", &[])?;
            holder.member("Range")?.member("Font")?.call_member("Reset", &[])?;
        }
    }
    let kind = prop(op, "kind");
    Ok(ordered(vec![
        ("op", Value::string("insert_break")),
        ("changed", Value::Bool(true)),
        ("kind", Value::String(if truthy(&kind) { text_of(&kind) } else { "page".to_owned() })),
    ]))
}

/// The range a link, bookmark or note names: the paragraph, or the whole body.
fn target_range(document: &Obj, op: &Value) -> Result<Com> {
    if truthy(&prop(op, "paragraph")) {
        super::item(&document.get("Paragraphs")?, cast_int(&prop(op, "paragraph"))?)?.member("Range")?.member("Duplicate")
    } else {
        document.get("Content")?.member("Duplicate")
    }
}

/// `$range.Find.Execute([string]$op.find, $false, $false, $false, $false, $false, $true)`.
fn find_phrase(range: &Com, op: &Value) -> Result<bool> {
    let arguments =
        [Com::from(text_of(&prop(op, "find"))), Com::Bool(false), Com::Bool(false), Com::Bool(false), Com::Bool(false), Com::Bool(false), Com::Bool(true)];
    Ok(super::truth(&range.member("Find")?.call_member("Execute", &arguments)?))
}

/// `add_hyperlink`.
pub(super) fn add_hyperlink(document: &Obj, op: &Value) -> Result<Value> {
    let range = target_range(document, op)?;
    if truthy(&prop(op, "find")) {
        if !find_phrase(&range, op)? {
            return Err(Error::host(format!("Hyperlink target text not found: {}", text_of(&prop(op, "find")))));
        }
    } else {
        // At the end of the paragraph's text, as the portable writer appends the link: laid over the whole paragraph, its
        // mark included, the link joined it to the next paragraph.
        if truthy(&prop(op, "paragraph")) {
            range.call_member("MoveEnd", &[Com::I4(1), Com::I4(-1)])?;
        }
        range.call_member("Collapse", &[Com::I4(0)])?;
    }
    let display = if !prop(op, "display").is_null() {
        text_of(&prop(op, "display"))
    } else if truthy(&prop(op, "find")) {
        super::string(&range.member("Text")?)
    } else {
        text_of(&prop(op, "address"))
    };
    let link = document
        .get("Hyperlinks")?
        .call_member("Add", &[range, Com::from(text_of(&prop(op, "address"))), Com::from(text_of(&prop(op, "subAddress"))), Com::Null, Com::from(display)])?;
    Ok(ordered(vec![
        ("op", Value::string("add_hyperlink")),
        ("changed", Value::Bool(true)),
        ("address", Value::String(super::string(&link.member("Address")?))),
        ("subAddress", Value::String(super::string(&link.member("SubAddress")?))),
    ]))
}

/// `add_bookmark`.
pub(super) fn add_bookmark(document: &Obj, op: &Value) -> Result<Value> {
    let range = target_range(document, op)?;
    if truthy(&prop(op, "find")) {
        if !find_phrase(&range, op)? {
            return Err(Error::host(format!("Bookmark target text not found: {}", text_of(&prop(op, "find")))));
        }
    } else if !truthy(&prop(op, "paragraph")) {
        range.call_member("Collapse", &[Com::I4(0)])?;
    }
    let bookmark = document.get("Bookmarks")?.call_member("Add", &[Com::from(text_of(&prop(op, "name"))), range])?;
    Ok(ordered(vec![("op", Value::string("add_bookmark")), ("changed", Value::Bool(true)), ("name", Value::String(super::string(&bookmark.member("Name")?)))]))
}

/// `set_content_control`: a control by tag or by index; a locked one refuses the write, and saying so beats a COM error.
pub(super) fn set_content_control(document: &Obj, op: &Value) -> Result<Value> {
    let tag = text_of(&prop(op, "tag"));
    let mut control: Option<Com> = None;
    let mut index = 1;
    while index <= super::count_of_collection(&document.get("ContentControls")?)? {
        let candidate = super::item(&document.get("ContentControls")?, index)?;
        if !tag.is_empty() {
            if same(&super::string(&candidate.member("Tag")?), &tag) {
                control = Some(candidate);
                break;
            }
        } else if index == cast_int(&prop(op, "control"))? {
            control = Some(candidate);
            break;
        }
        index += 1;
    }
    let Some(control) = control else {
        return Err(Error::host(if tag.is_empty() {
            format!("DOCX content control {} not found", text_of(&prop(op, "control")))
        } else {
            format!("DOCX content control not found for tag: {tag}")
        }));
    };
    if super::truth(&control.member("LockContents")?) {
        let name = if tag.is_empty() { text_of(&prop(op, "control")) } else { tag.clone() };
        return Err(Error::host(format!("DOCX content control {name} is locked for editing")));
    }
    control.member("Range")?.set_member("Text", Com::from(text_of(&prop(op, "text"))))?;
    let named = if tag.is_empty() { Value::Int(cast_int(&prop(op, "control"))?) } else { Value::String(tag) };
    Ok(ordered(vec![
        ("op", Value::string("set_content_control")),
        ("changed", Value::Bool(true)),
        ("control", named),
        ("tag", Value::String(super::string(&control.member("Tag")?))),
        ("text", Value::String(text_of(&prop(op, "text")))),
    ]))
}

/// `add_note`: a footnote or endnote at a phrase (extended to the end of the word it ends in) or at the end of a paragraph,
/// in the face of the text it cites, at 9 pt, tight.
pub(super) fn add_note(document: &Obj, op: &Value) -> Result<Value> {
    let given = prop(op, "kind");
    let kind = if truthy(&given) { lower(&text_of(&given)) } else { "footnote".to_owned() };
    if kind != "footnote" && kind != "endnote" {
        return Err(Error::host("add_note kind must be footnote or endnote"));
    }
    let range = target_range(document, op)?;
    let mut anchor = "paragraph";
    if truthy(&prop(op, "find")) {
        if !find_phrase(&range, op)? {
            return Err(Error::host(format!("Note anchor text not found: {}", text_of(&prop(op, "find")))));
        }
        anchor = "phrase";
        // The mark goes at the end of the word the phrase ends in, as the portable writer sets it. Only a phrase cut inside
        // a word runs on; one ending on a sign ("92.8%") keeps its mark there.
        let content_end = super::int(&document.get("Content")?.member("End")?)?;
        let cut_in_word = text::is_match(&text_of(&prop(op, "find")), "[\\p{L}\\p{N}]$", false).map_err(Error::host)?;
        while cut_in_word && super::int(&range.member("End")?)? < content_end {
            let start = super::int(&range.member("End")?)?;
            let end = super::int(&range.member("End")?)? + 1;
            let next = super::string(&super::document_range(document, start, end)?.member("Text")?);
            if !text::is_match(&next, "^[\\p{L}\\p{N}]$", false).map_err(Error::host)? {
                break;
            }
            let end = super::int(&range.member("End")?)? + 1;
            range.set_member("End", Com::I4(end))?;
        }
    }
    // The note reads in the face of the text it cites, as the portable writer sets it.
    let cited_font = range.member("Font")?;
    let cited_name = cited_font.member("Name").map(|value| super::string(&value)).unwrap_or_default();
    let cited_far_east = cited_font.member("NameFarEast").map(|value| super::string(&value)).unwrap_or_default();
    // The mark follows the cited phrase, so the range collapses to its end; a paragraph's end is the end of its text,
    // inside its mark.
    if truthy(&prop(op, "paragraph")) && !truthy(&prop(op, "find")) {
        range.call_member("MoveEnd", &[Com::I4(1), Com::I4(-1)])?;
    }
    range.call_member("Collapse", &[Com::I4(0)])?;
    let notes = document.get(if kind == "endnote" { "Endnotes" } else { "Footnotes" })?;
    let note = notes.call_member("Add", &[range, Com::from(""), Com::from(text_of(&prop(op, "text")))])?;
    let _ = (|| -> Result<()> {
        if !cited_name.is_empty() {
            note.member("Range")?.member("Font")?.set_member("Name", Com::from(cited_name.as_str()))?;
        }
        if !cited_far_east.is_empty() {
            note.member("Range")?.member("Font")?.set_member("NameFarEast", Com::from(cited_far_east.as_str()))?;
        }
        // The whole paragraph, the mark and the space after it included: the note's range leaves them out.
        for note_paragraph in super::items_of(&note.member("Range")?.member("Paragraphs")?)? {
            note_paragraph.member("Range")?.member("Font")?.set_member("Size", Com::I4(9))?;
        }
        // Tight, single-spaced, 2 pt apart, as the portable writer's note style.
        let format = note.member("Range")?.member("ParagraphFormat")?;
        format.set_member("SpaceBefore", Com::I4(0))?;
        format.set_member("SpaceAfter", Com::I4(2))?;
        format.set_member("LineSpacingRule", Com::I4(0))
    })();
    Ok(ordered(vec![
        ("op", Value::string("add_note")),
        ("changed", Value::Bool(true)),
        ("kind", Value::String(kind)),
        ("note", Value::Int(super::int(&note.member("Index")?)?)),
        ("anchor", Value::string(anchor)),
    ]))
}

/// `set_page`: orientation (the sheet turned the way the section now lies), margins, and 1 to 12 text columns.
pub(super) fn set_page(document: &Obj, op: &Value) -> Result<Value> {
    // Without an explicit section the edit lands on the one being written into, the last.
    let sections = document.get("Sections")?;
    let at = if truthy(&prop(op, "section")) { cast_int(&prop(op, "section"))? } else { super::count_of_collection(&document.get("Sections")?)? };
    let section = super::item(&sections, at)?;
    let props = prop(op, "properties");
    let orientation = prop(&props, "orientation");
    if truthy(&orientation) {
        let landscape = same(&text_of(&orientation), "landscape");
        section.member("PageSetup")?.set_member("Orientation", Com::I4(i32::from(landscape)))?;
    }
    // pageSize arrives as points; the sheet is turned the way the section now lies.
    if !prop(&props, "pageWidth").is_null() && !prop(&props, "pageHeight").is_null() {
        let mut width = cast_single(&prop(&props, "pageWidth"))?;
        let mut height = cast_single(&prop(&props, "pageHeight"))?;
        if (super::int(&section.member("PageSetup")?.member("Orientation")?)? == 1) == (width < height) {
            std::mem::swap(&mut width, &mut height);
        }
        section.member("PageSetup")?.set_member("PageWidth", Com::R4(width))?;
        section.member("PageSetup")?.set_member("PageHeight", Com::R4(height))?;
    }
    for (key, member) in [("topMargin", "TopMargin"), ("bottomMargin", "BottomMargin"), ("leftMargin", "LeftMargin"), ("rightMargin", "RightMargin")] {
        if truthy(&prop(&props, key)) {
            section.member("PageSetup")?.set_member(member, r4(&prop(&props, key))?)?;
        }
    }
    // Columns are a property of the section, so the text flows through them instead of being placed into boxes; 1 returns
    // the section to one column.
    if !prop(&props, "columns").is_null() {
        let column_count = cast_int(&prop(&props, "columns"))?;
        if !(1..=12).contains(&column_count) {
            return Err(Error::host("set_page columns must be a whole number from 1 to 12"));
        }
        section.member("PageSetup")?.member("TextColumns")?.call_member("SetCount", &[Com::I4(column_count)])?;
        if column_count > 1 {
            section.member("PageSetup")?.member("TextColumns")?.set_member("EvenlySpaced", Com::I4(-1))?;
            let spacing = prop(&props, "columnSpacing");
            let spacing = if spacing.is_null() { Com::R4(35.4) } else { r4(&spacing)? };
            section.member("PageSetup")?.member("TextColumns")?.set_member("Spacing", spacing)?;
        }
    } else if !prop(&props, "columnSpacing").is_null() {
        section.member("PageSetup")?.member("TextColumns")?.set_member("EvenlySpaced", Com::I4(-1))?;
        section.member("PageSetup")?.member("TextColumns")?.set_member("Spacing", r4(&prop(&props, "columnSpacing"))?)?;
    }
    Ok(ordered(vec![
        ("op", Value::string("set_page")),
        ("changed", Value::Bool(true)),
        ("section", super::ps_value(&section.member("Index")?, "System.Object")?),
        ("columns", Value::Int(super::int(&section.member("PageSetup")?.member("TextColumns")?.member("Count")?)?)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_a_paragraph_says_leaves_out_marks_and_breaks() {
        assert_eq!(bare_text("\r\u{7}\u{b}\u{e}", false), "");
        assert_eq!(bare_text("\u{c}\r", false), "\u{c}");
        assert_eq!(bare_text("\u{c}\r", true), "");
        assert_eq!(bare_text("a\r", true), "a");
    }

    #[test]
    fn an_alignment_the_line_cannot_take_is_refused_with_the_scripts_text() {
        assert_eq!(formatting::line_alignment(&Value::string("Centre"), "x").unwrap(), 1);
        assert_eq!(
            formatting::line_alignment(&Value::string("middle"), "set_header_footer alignment").unwrap_err().message(),
            "set_header_footer alignment must be left, center, right, or justify, not middle"
        );
    }
}
