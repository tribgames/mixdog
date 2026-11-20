//! Appending a paragraph at the document's end: `Word-EndParagraph`, `Format-WordAppended`, and the batching of paragraphs
//! appended one after another (`Word-CanJoinAppend`, `Word-AppendRunLength`, `Word-AppendFormatKey`, `Apply-WordAppendRun`).

use super::Com;
use super::Para;
use super::Value;
use super::formatting;
use super::lists;
use super::prop;
use super::text_of;
use super::truthy;
use crate::com::Obj;
use crate::com::Result;
use crate::ps::ObjectKind;
use crate::ps::json;
use crate::ps::text;

/// What `Format-WordAppended` answers: the style it applied and the one the document lacks.
pub(super) struct Appended {
    pub style: String,
    pub style_not_found: Option<String>,
}

/// `Word-EndParagraph`: the paragraph at the document's end that the next block goes into. The last paragraph is taken when
/// it is waiting for content (the one empty paragraph of a new document, the empty one closing a table, or the empty one
/// Word opens after a break) and a new paragraph is opened after it otherwise. A table never takes the paragraph closing
/// another table, nor an empty paragraph the author wrote. Answers the document's paragraph count.
pub(super) fn end_paragraph(document: &Obj, for_table: bool) -> Result<i32> {
    let last = document.get("Paragraphs")?.member("Last")?;
    let empty = crate::ps::payload::names_equal(&super::string(&last.member("Range")?.member("Text")?), "\r");
    // Only an empty last paragraph can be waiting; the one before it is asked about only then.
    let mut waiting = false;
    if empty {
        let previous = last.call_member("Previous", &[]).ok().filter(super::is_object);
        let mut after_table = false;
        let mut after_break = false;
        if let Some(before) = &previous {
            after_table =
                (|| -> Result<bool> { Ok(super::truth(&super::indexed(&before.member("Range")?, "Information", &[Com::I4(12)])?)) })().unwrap_or(false);
            // A page or column break sits before its paragraph's mark; a section break is the mark.
            after_break = !after_table
                && text::is_match(&super::string(&before.member("Range")?.member("Text")?), "[\\x0c\\x0e]\r?$", false).map_err(crate::com::Error::host)?;
        }
        waiting = previous.is_none() || after_break || (after_table && !for_table);
    }
    if !waiting {
        document.get("Content")?.call_member("InsertParagraphAfter", &[])?;
    }
    // A paragraph opened under tracked changes is an insertion already, and resetting what it inherited is part of it:
    // tracked as a change of its own, every appended paragraph showed a reviewer a "Formatted" revision the portable
    // writer never records. A paragraph taken as it stood stays tracked.
    let mut quiet = !waiting
        && (|| -> Result<bool> { Ok(super::truth(&document.get("TrackRevisions")?) && super::truth(&document.get("TrackFormatting")?)) })().unwrap_or(false);
    if quiet && document.put("TrackFormatting", Com::Bool(false)).is_err() {
        quiet = false;
    }
    // `$doc.Paragraphs.Last` is read inside the script's try, so TrackFormatting comes back when that read fails too.
    let reset = document.get("Paragraphs").and_then(|paragraphs| paragraphs.member("Last")).and_then(|last| lists::reset_paragraph(&Para::Real(last)));
    if quiet {
        let _ = document.put("TrackFormatting", Com::Bool(true));
    }
    reset?;
    super::count_of(document)
}

/// The style an operation names, itself or through its properties.
pub(super) fn style_of(op: &Value) -> String {
    let own = prop(op, "style");
    if truthy(&own) {
        return text_of(&own);
    }
    let nested = prop(&prop(op, "properties"), "style");
    if truthy(&nested) { text_of(&nested) } else { String::new() }
}

/// `Format-WordAppended`: the formatting append_text asks for, on one appended paragraph or on a run of them at once.
pub(super) fn format_appended(document: &Obj, paragraph: &Para, paragraph_index: i32, op: &Value) -> Result<Appended> {
    let props = prop(op, "properties");
    // The style comes first: applying a paragraph style resets its list format, so a bullet set before style:'Normal'
    // was dropped in Word and kept by the portable writer.
    let style = style_of(op);
    // The paragraph opens as Normal (Word-EndParagraph resets it), so Normal is not applied again.
    let style_not_found =
        if !style.is_empty() && !formatting::style_value(&style).is_normal() { formatting::set_style(&paragraph.range()?, &style) } else { None };
    let kind = prop(&props, "listKind");
    if truthy(&kind) {
        let kind = text::to_lower_invariant(&text_of(&kind));
        let apply = || -> Result<()> {
            if kind == "number" {
                lists::apply_number(document, paragraph, paragraph_index, truthy(&prop(&props, "listContinue")), &prop(&props, "listNumbering"))
            } else if kind != "none" {
                lists::apply_bullet(document, paragraph)
            } else {
                paragraph.range()?.member("ListFormat")?.call_member("RemoveNumbers", &[]).map(|_| ())
            }
        };
        // A named style stays on the item, as the portable writer keeps it; with none, both paths use List Paragraph.
        if style.is_empty() {
            apply()?
        } else {
            lists::in_list_style(document, apply)?
        }
        let level = super::cast_int(&prop(&props, "listLevel"))?;
        if level > 0 {
            // The level is a property of the list format; indenting one step at a time depends on the template's tab
            // stops and can stop short.
            let set = (|| -> Result<()> {
                paragraph.range()?.member("ListFormat")?.set_member("ListLevelNumber", Com::I4(super::cast_int(&prop(&props, "listLevel"))? + 1))
            })();
            if set.is_err() {
                for _ in 0..level {
                    paragraph.range()?.member("ListFormat")?.call_member("ListIndent", &[])?;
                }
            }
        }
    } else if style.is_empty() {
        // A named style already set the list format it carries (List Bullet keeps its bullet).
        paragraph.range()?.member("ListFormat")?.call_member("RemoveNumbers", &[])?;
    }
    formatting::set_run_format(&paragraph.range()?, &props)?;
    let format = paragraph.format()?;
    let alignment = prop(&props, "alignment");
    if truthy(&alignment) {
        format.set_member("Alignment", Com::I4(formatting::paragraph_alignment(&alignment)))?;
    }
    formatting::set_paragraph_flow(&format, &props)?;
    formatting::set_list_item_inset(&format, &props)?;
    formatting::set_tab_stops(&format, &props)?;
    let border = prop(&props, "border");
    if truthy(&border) {
        formatting::set_paragraph_border(paragraph, &border)?;
    }
    Ok(Appended { style, style_not_found })
}

/// The result of one appended paragraph.
pub(super) fn append_result(index: i32, formatted: &Appended) -> Value {
    let mut pairs = vec![
        ("op", Value::string("append_text")),
        ("changed", Value::Bool(true)),
        ("paragraph", Value::Int(index)),
        ("path", Value::String(format!("/body/p[{index}]"))),
        ("style", Value::String(formatted.style.clone())),
    ];
    if let Some(missing) = &formatted.style_not_found {
        pairs.push(("styleNotFound", Value::String(missing.clone())));
    }
    Value::object(ObjectKind::Ordered, pairs)
}

/// `Word-CanJoinAppend`: a tracked edit, a labelled one, or text that breaks lines itself is appended alone.
fn can_join(op: &Value) -> bool {
    crate::ps::payload::names_equal(&text_of(&prop(op, "op")), "append_text")
        && prop(op, "author").is_null()
        && !text_of(&prop(op, "text")).contains(['\r', '\n', '\u{b}', '\u{c}'])
}

/// `Word-AppendRunLength`: how many operations from `position` are appended as one block (1: this one alone).
pub(super) fn run_length(document: &Obj, queue: &[Value], position: usize) -> Result<usize> {
    if !can_join(&queue[position]) || position + 1 >= queue.len() || super::truth(&document.get("TrackRevisions")?) {
        return Ok(1);
    }
    let mut count = 1;
    while position + count < queue.len() && can_join(&queue[position + count]) {
        count += 1;
    }
    Ok(count)
}

/// `Word-AppendFormatKey`: neighbours in one style and one set of properties share the key and are formatted as one range.
fn format_key(op: &Value) -> String {
    format!("{}\0{}", style_of(op), json::to_json(&prop(op, "properties"), 8))
}

/// `Apply-WordAppendRun`: the block as one insertion at the document's end. The first paragraph is the one the next block
/// takes (reset), the rest open from it. One result per operation, each naming its own paragraph.
pub(super) fn apply_run(document: &Obj, ops: &[Value]) -> Result<Vec<Value>> {
    let paragraph_index = end_paragraph(document, false)?;
    let text_range = document.get("Paragraphs")?.member("Last")?.member("Range")?.member("Duplicate")?;
    text_range.call_member("MoveEnd", &[Com::I4(1), Com::I4(-1)])?;
    let joined: Vec<String> = ops.iter().map(|op| text_of(&prop(op, "text"))).collect();
    text_range.set_member("Text", Com::from(joined.join("\r")))?;
    let mut results = Vec::new();
    let mut first = 0;
    while first < ops.len() {
        let key = format_key(&ops[first]);
        let mut last = first;
        while last + 1 < ops.len() && format_key(&ops[last + 1]) == key {
            last += 1;
        }
        let paragraphs = |offset: usize| -> Result<Com> { super::item(&document.get("Paragraphs")?, paragraph_index + offset as i32)?.member("Range") };
        let start = super::int(&paragraphs(first)?.member("Start")?)?;
        let end = super::int(&paragraphs(last)?.member("End")?)?;
        let range = super::document_range(document, start, end)?;
        let target = Para::Block { format: range.member("ParagraphFormat")?, borders: range.member("Borders")?, range };
        let formatted = format_appended(document, &target, paragraph_index + first as i32, &ops[first])?;
        for offset in first..=last {
            results.push(append_result(paragraph_index + offset as i32, &formatted));
        }
        first = last + 1;
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ps::payload::parse_payload;

    fn op(json: &str) -> Value {
        parse_payload(json).expect("an operation")
    }

    #[test]
    fn only_plain_unlabelled_appends_join_a_run() {
        assert!(can_join(&op(r#"{"op":"append_text","text":"a"}"#)));
        assert!(!can_join(&op(r#"{"op":"append_text","text":"a\nb"}"#)));
        assert!(!can_join(&op(r#"{"op":"append_text","text":"a","author":"Rev"}"#)));
        assert!(!can_join(&op(r#"{"op":"replace_text","text":"a"}"#)));
    }

    #[test]
    fn neighbours_in_one_style_and_properties_share_a_key() {
        let a = op(r#"{"op":"append_text","style":"Quote","properties":{"bold":true}}"#);
        let b = op(r#"{"op":"append_text","properties":{"style":"Quote","bold":true}}"#);
        let c = op(r#"{"op":"append_text","style":"Quote","properties":{"bold":false}}"#);
        assert_eq!(style_of(&a), "Quote");
        assert_eq!(style_of(&b), "Quote");
        assert_ne!(format_key(&a), format_key(&c));
    }

    #[test]
    fn a_result_names_its_paragraph_and_a_missing_style() {
        let found = Appended { style: "Heading1".to_owned(), style_not_found: Some("Fancy".to_owned()) };
        assert_eq!(
            json::to_json(&append_result(4, &found), 4),
            r#"{"op":"append_text","changed":true,"paragraph":4,"path":"/body/p[4]","style":"Heading1","styleNotFound":"Fancy"}"#
        );
    }
}
