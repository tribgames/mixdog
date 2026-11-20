//! The text operations of `Invoke-WordOperation`: `replace_text`, `append_text`, `set_paragraph_text`, `remove_paragraph`,
//! `move_paragraph` and `add_image`, with `Word-EditableParagraph`.

use std::sync::OnceLock;

use regex::Regex;

use super::Com;
use super::Para;
use super::Value;
use super::append;
use super::cast_int;
use super::cast_single;
use super::formatting;
use super::ordered;
use super::prop;
use super::text_of;
use super::truthy;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::ps::ObjectKind;
use crate::ps::convert;

/// The most matches a replace_text rewrites.
const REPLACE_LIMIT: i32 = 10_000;

/// `[regex]::Matches($text, '\s+|\S+')`: the words and the spaces between them, in order.
fn words_and_spaces(text: &str) -> Vec<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\s+|\S+").expect("the word pattern is valid")).find_iter(text).map(|found| found.as_str().to_owned()).collect()
}

/// The length .NET gives a string: UTF-16 units.
fn units(text: &str) -> i32 {
    text.encode_utf16().count() as i32
}

/// The words `replace_text` rewrites: what the find and the replacement share at either end stays as it is.
#[derive(Debug, PartialEq, Eq)]
struct SharedEdges {
    lead_chars: i32,
    trail_chars: i32,
    insert: String,
}

/// `replace_text`'s shared-word-edges rule (docx-tracked-edits sharedWordEdges): under tracking, "86억 원으로" to
/// "86억 원(잠정)으로" marks "원으로" to "원(잠정)으로", not the whole phrase.
fn shared_edges(find: &str, replacement: &str) -> SharedEdges {
    let before = words_and_spaces(find);
    let after = words_and_spaces(replacement);
    let same = |left: &str, right: &str| convert::equals_case_sensitive(&Value::string(left), &Value::string(right));
    let mut lead = 0;
    while lead < before.len() && lead < after.len() && same(&before[lead], &after[lead]) {
        lead += 1;
    }
    let mut trail = 0;
    while trail < before.len() - lead && trail < after.len() - lead && same(&before[before.len() - 1 - trail], &after[after.len() - 1 - trail]) {
        trail += 1;
    }
    let lead_chars = units(&before[..lead].concat());
    let trail_chars = if trail == 0 { 0 } else { units(&before[before.len() - trail..].concat()) };
    SharedEdges { lead_chars, trail_chars, insert: after[lead..after.len() - trail].concat() }
}

/// `replace_text`.
pub(super) fn replace_text(document: &Obj, op: &Value) -> Result<Value> {
    let find = text_of(&prop(op, "find"));
    let replacement = text_of(&prop(op, "replace"));
    if find.is_empty() {
        return Err(Error::host("replace_text requires non-empty find"));
    }
    let edges = shared_edges(&find, &replacement);
    let mut count = 0;
    let mut range = document.get("Content")?.member("Duplicate")?;
    let mut resume_at = 0;
    loop {
        let execute =
            [Com::from(find.as_str()), Com::Bool(false), Com::Bool(false), Com::Bool(false), Com::Bool(false), Com::Bool(false), Com::Bool(true), Com::I4(0)];
        if !super::truth(&range.member("Find")?.call_member("Execute", &execute)?) {
            break;
        }
        let match_start = super::int(&range.member("Start")?)?;
        let match_end = super::int(&range.member("End")?)?;
        // A search resumed inside a table cell comes back to the cell's start and finds the struck words it just
        // replaced: a match before the point the search resumed from is the one already done.
        if match_start < resume_at {
            break;
        }
        let deleted = (match_end - match_start) - edges.lead_chars - edges.trail_chars;
        let target = super::document_range(document, match_start + edges.lead_chars, match_end - edges.trail_chars)?;
        target.set_member("Text", Com::from(edges.insert.as_str()))?;
        count += 1;
        if count > REPLACE_LIMIT {
            break;
        }
        // The search resumes past the whole edit. Under tracking the struck words stay in the story beside the inserted
        // ones, and Find still reads them.
        let inserted = units(&edges.insert);
        let resume = if super::truth(&document.get("TrackRevisions")?) { match_end + inserted } else { match_end - deleted + inserted };
        resume_at = resume.min(super::int(&document.get("Content")?.member("End")?)?);
        range = super::document_range(document, resume_at, super::int(&document.get("Content")?.member("End")?)?)?;
    }
    Ok(ordered(vec![("op", Value::string("replace_text")), ("changed", Value::Bool(count > 0)), ("count", Value::Int(count))]))
}

/// `append_text`: the text goes into the paragraph at the document's end (writing "text\r" over the last paragraph left an
/// empty paragraph after every document).
pub(super) fn append_text(document: &Obj, op: &Value) -> Result<Value> {
    let paragraph_index = append::end_paragraph(document, false)?;
    let paragraph = super::item(&document.get("Paragraphs")?, paragraph_index)?;
    let text_range = paragraph.member("Range")?.member("Duplicate")?;
    text_range.call_member("MoveEnd", &[Com::I4(1), Com::I4(-1)])?;
    text_range.set_member("Text", Com::from(text_of(&prop(op, "text"))))?;
    let target = Para::Real(super::item(&document.get("Paragraphs")?, paragraph_index)?);
    let formatted = append::format_appended(document, &target, paragraph_index, op)?;
    Ok(append::append_result(paragraph_index, &formatted))
}

/// `Word-EditableParagraph`: a paragraph an edit may rewrite. One inside a table of contents is Word's own field result,
/// which the contents rebuild from the headings, so say that.
pub(super) fn editable_paragraph(document: &Obj, index: i32, op_name: &str) -> Result<Com> {
    let paragraph = super::item(&document.get("Paragraphs")?, index)?;
    let start = super::int(&paragraph.member("Range")?.member("Start")?)?;
    for toc in super::items_of(&document.get("TablesOfContents")?)? {
        if start >= super::int(&toc.member("Range")?.member("Start")?)? && start < super::int(&toc.member("Range")?.member("End")?)? {
            return Err(Error::host(format!(
                "{op_name} paragraph {index} is an entry of the table of contents, which Word rebuilds from the headings: edit the heading it lists, or name a paragraph outside the contents."
            )));
        }
    }
    Ok(paragraph)
}

/// `set_paragraph_text`: the text inside the paragraph mark, which stays with its formatting.
pub(super) fn set_paragraph_text(document: &Obj, op: &Value) -> Result<Value> {
    let range = editable_paragraph(document, cast_int(&prop(op, "paragraph"))?, "set_paragraph_text")?.member("Range")?.member("Duplicate")?;
    range.call_member("MoveEnd", &[Com::I4(1), Com::I4(-1)])?;
    range.set_member("Text", Com::from(text_of(&prop(op, "text"))))?;
    Ok(ordered(vec![("op", Value::string("set_paragraph_text")), ("changed", Value::Bool(true))]))
}

/// `remove_paragraph`.
pub(super) fn remove_paragraph(document: &Obj, op: &Value) -> Result<Value> {
    let paragraph = editable_paragraph(document, cast_int(&prop(op, "paragraph"))?, "remove_paragraph")?;
    // The only paragraph between two tables keeps them two; deleting its mark joins them: the words go and the empty
    // paragraph stays.
    let neighbour_in_table = |neighbour: &str| -> bool {
        (|| -> Result<bool> { Ok(super::truth(&super::indexed(&paragraph.call_member(neighbour, &[])?.member("Range")?, "Information", &[Com::I4(12)])?)) })()
            .unwrap_or(false)
    };
    let previous_in_table = neighbour_in_table("Previous");
    let next_in_table = neighbour_in_table("Next");
    if previous_in_table && next_in_table {
        let words = paragraph.member("Range")?.member("Duplicate")?;
        let grows = |range: &Com| -> Result<bool> { Ok(super::int(&range.member("End")?)? > super::int(&range.member("Start")?)?) };
        if grows(&words)? {
            words.call_member("MoveEnd", &[Com::I4(1), Com::I4(-1)])?;
        }
        if grows(&words)? {
            words.call_member("Delete", &[])?;
        }
        return Ok(ordered(vec![("op", Value::string("remove_paragraph")), ("changed", Value::Bool(true)), ("keptBetweenTables", Value::Bool(true))]));
    }
    paragraph.member("Range")?.call_member("Delete", &[])?;
    Ok(ordered(vec![("op", Value::string("remove_paragraph")), ("changed", Value::Bool(true))]))
}

/// `move_paragraph`: FormattedText hands back the paragraph's own range, not a copy: the copy lands first and the source
/// goes after, placed before the index-th paragraph that remains, or after the last one.
pub(super) fn move_paragraph(document: &Obj, op: &Value) -> Result<Value> {
    let paragraphs = document.get("Paragraphs")?;
    let from = cast_int(&prop(op, "paragraph"))?;
    let source = editable_paragraph(document, from, "move_paragraph")?.member("Range")?.member("Duplicate")?;
    let wanted = 1_i32.max(cast_int(&prop(op, "index"))?);
    let anchor = if wanted >= from { wanted + 1 } else { wanted };
    let count = || super::count_of_collection(&paragraphs);
    if anchor <= count()? {
        let destination = super::item(&paragraphs, anchor)?.member("Range")?.member("Duplicate")?;
        destination.call_member("Collapse", &[Com::I4(1)])?;
        destination.set_member("FormattedText", source.member("FormattedText")?)?;
        source.call_member("Delete", &[])?;
    } else if from < count()? {
        // After the last paragraph: Word's final mark cannot move, so the copy goes into a new last paragraph, the empty
        // one left after it is joined, and the paragraph takes back its own style and format.
        let style = super::string(&super::item(&paragraphs, from)?.member("Style")?.member("NameLocal")?);
        let format = super::item(&paragraphs, from)?.member("Format")?.member("Duplicate")?;
        super::item(&paragraphs, count()?)?.member("Range")?.call_member("InsertParagraphAfter", &[])?;
        let destination = super::item(&paragraphs, count()?)?.member("Range")?.member("Duplicate")?;
        destination.set_member("FormattedText", source.member("FormattedText")?)?;
        source.call_member("Delete", &[])?;
        let last_text = super::item(&paragraphs, count()?)?.member("Range")?.member("Text")?;
        if crate::ps::payload::names_equal(&super::string(&last_text), "\r") {
            super::item(&paragraphs, count()? - 1)?.member("Range")?.member("Characters")?.member("Last")?.call_member("Delete", &[])?;
        }
        let moved = super::item(&paragraphs, count()?)?;
        moved.set_member("Style", Com::from(style))?;
        moved.set_member("Format", format)?;
    }
    Ok(ordered(vec![("op", Value::string("move_paragraph")), ("changed", Value::Bool(true))]))
}

/// `add_image`: the picture takes a paragraph of its own where the batch has reached, after the named paragraph or at the
/// end of the document, the way the portable writer places it.
pub(super) fn add_image(document: &Obj, op: &Value) -> Result<Value> {
    let single_or_zero = |name: &str| -> Result<f32> {
        let value = prop(op, name);
        if truthy(&value) { cast_single(&value) } else { Ok(0.0) }
    };
    let width = single_or_zero("width")?;
    let height = single_or_zero("height")?;
    let picture_paragraph = if truthy(&prop(op, "paragraph")) {
        let anchor = super::item(&document.get("Paragraphs")?, cast_int(&prop(op, "paragraph"))?)?.member("Range")?.member("Duplicate")?;
        anchor.call_member("Collapse", &[Com::I4(0)])?;
        document.get("Paragraphs")?.call_member("Add", &[anchor])?
    } else {
        // At the end the picture takes the paragraph the next block would (Word-EndParagraph).
        let paragraphs = document.get("Paragraphs")?;
        let at = append::end_paragraph(document, false)?;
        super::item(&paragraphs, at)?
    };
    let picture_range = picture_paragraph.member("Range")?.member("Duplicate")?;
    picture_range.call_member("Collapse", &[Com::I4(1)])?;
    let shape =
        document.get("InlineShapes")?.call_member("AddPicture", &[Com::from(text_of(&prop(op, "path"))), Com::Bool(false), Com::Bool(true), picture_range])?;
    if width > 0.0 {
        shape.set_member("Width", Com::R4(width))?;
    }
    if height > 0.0 {
        shape.set_member("Height", Com::R4(height))?;
    }
    if truthy(&prop(op, "altText")) {
        shape.set_member("AlternativeText", Com::from(text_of(&prop(op, "altText"))))?;
    }
    // A new paragraph takes the formatting of the one before it, so it starts from Normal, as the portable writer's bare
    // paragraph does. It keeps with the paragraph after it (its caption) unless the caller says otherwise.
    let paragraph = Para::Real(super::item(&shape.member("Range")?.member("Paragraphs")?, 1)?);
    let _ = paragraph.range().and_then(|range| range.member("ListFormat")).and_then(|format| format.call_member("RemoveNumbers", &[]));
    let _ = paragraph.format().and_then(|format| format.call_member("Reset", &[]));
    let mut flow = crate::ps::Object::new(ObjectKind::Custom);
    flow.set("keepWithNext", Value::Bool(true));
    if let Value::Object(own) = prop(op, "properties") {
        for (name, value) in own.entries {
            flow.set(&name, value);
        }
    }
    let flow = Value::Object(flow);
    if truthy(&prop(&flow, "alignment")) {
        paragraph.format()?.set_member("Alignment", Com::I4(formatting::paragraph_alignment(&prop(&flow, "alignment"))))?;
    }
    formatting::set_paragraph_flow(&paragraph.format()?, &flow)?;
    Ok(ordered(vec![("op", Value::string("add_image")), ("changed", Value::Bool(true))]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replacement_rewrites_only_the_words_between_the_shared_edges() {
        let edges = shared_edges("86억 원으로", "86억 원(잠정)으로");
        assert_eq!(edges, SharedEdges { lead_chars: 4, trail_chars: 0, insert: "원(잠정)으로".to_owned() });
        let edges = shared_edges("the old way", "the new way");
        assert_eq!(edges, SharedEdges { lead_chars: 4, trail_chars: 4, insert: "new".to_owned() });
    }

    #[test]
    fn a_phrase_with_nothing_shared_is_replaced_whole() {
        assert_eq!(shared_edges("old", "new"), SharedEdges { lead_chars: 0, trail_chars: 0, insert: "new".to_owned() });
        assert_eq!(shared_edges("a b", "a b"), SharedEdges { lead_chars: 3, trail_chars: 0, insert: String::new() });
    }

    #[test]
    fn lengths_count_utf16_units() {
        assert_eq!(units("a\u{1F600}"), 3);
    }
}
