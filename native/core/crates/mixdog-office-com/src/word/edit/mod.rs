//! The Word editor of `office-com-host.ps1`: `Apply-WordOperation` and the 41 operations of `Invoke-WordOperation`, registered
//! as the `docx` [`FormatEditor`](crate::format::FormatEditor).
//!
//! * [`author`]: the author wrapper (the application's user name and initials for the length of one operation).
//! * [`formatting`]: `office-word-formatting.ps1`, `Set-WordTabStops`, `Word-StyleValue` and `Set-WordStyle`.
//! * [`lists`]: the bullet, number and Korean number templates, and what applies them.
//! * [`append`]: `Word-EndParagraph`, `Format-WordAppended` and the batching of appended paragraphs.
//! * [`text`]: `replace_text`, `append_text`, `set_paragraph_text`, `remove_paragraph`, `move_paragraph`, `add_image`.
//! * [`styles`]: `set_document_font`, `define_styles`, `set_font`, `set_paragraph_style`, `set_paragraph_format`, `set_list`.
//! * [`review`]: comments, provenance, tracked changes.
//! * [`structure`]: headers and footers, the table of contents, page numbers, breaks, links, bookmarks, content controls,
//!   notes and page setup.
//! * [`template`]: `fill_template`.
//! * [`tables`]: the table operations and their helpers.
//!
//! Every COM access is made where the script made it and in its order (a member chain is read from its root each time the
//! script wrote it, an argument is evaluated after the target it is passed to), each `try { } catch { }` of the script is a
//! place where a failure is dropped, and every operation answers its result record with the keys in the script's order.

mod append;
mod author;
mod formatting;
mod lists;
mod review;
mod structure;
mod styles;
mod tables;
mod template;
mod text;

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::format::EditContext;
use crate::format::FormatEditor;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::text as ps_text;
use crate::word::count as count_of_collection;
use crate::word::document_range;
use crate::word::double;
use crate::word::indexed;
use crate::word::int;
use crate::word::is_object;
use crate::word::item;
use crate::word::items_of;
use crate::word::ps_value;
use crate::word::single;
use crate::word::string;
use crate::word::truth;

/// The operations the editor serves, in the order of the registry (`tests/fixtures/registry/operations.json`).
const OPERATIONS: &[&str] = &[
    "add_bookmark",
    "add_comment",
    "add_comment_reply",
    "add_hyperlink",
    "add_image",
    "add_note",
    "add_page_numbers",
    "add_provenance",
    "add_table",
    "append_text",
    "define_styles",
    "delete_comment",
    "delete_table_column",
    "delete_table_row",
    "fill_template",
    "fit_table",
    "insert_break",
    "insert_table_column",
    "insert_table_row",
    "insert_toc",
    "merge_table_cells",
    "move_paragraph",
    "normalize_runs",
    "remove_paragraph",
    "replace_text",
    "resolve_revision",
    "resolve_revisions",
    "set_comment_resolved",
    "set_content_control",
    "set_document_font",
    "set_font",
    "set_header_footer",
    "set_list",
    "set_page",
    "set_paragraph_format",
    "set_paragraph_style",
    "set_paragraph_text",
    "set_table_cell",
    "set_table_cell_style",
    "set_table_style",
    "track_changes",
];

/// The editor of `docx` documents.
pub struct Editor;

/// `$value.Name` of a request: the operation's own property, `$null` where it has none.
fn prop(value: &Value, name: &str) -> Value {
    payload::property(value, name)
}

/// `[bool]$value`.
fn truthy(value: &Value) -> bool {
    convert::to_bool(value)
}

/// `[string]$value`.
fn text_of(value: &Value) -> String {
    convert::to_ps_string(value)
}

/// `([string]$text).ToLowerInvariant()`.
fn lower(text: &str) -> String {
    ps_text::to_lower_invariant(text)
}

/// `-eq` on two strings: ordinal, ignoring case.
fn same(left: &str, right: &str) -> bool {
    payload::names_equal(left, right)
}

/// `[int]$value`, with the cast's own refusal.
fn cast_int(value: &Value) -> Result<i32> {
    convert::to_int(value).map_err(Error::host)
}

/// `[double]$value`.
fn cast_double(value: &Value) -> Result<f64> {
    convert::to_double(value).map_err(Error::host)
}

/// `[single]$value`.
fn cast_single(value: &Value) -> Result<f32> {
    convert::to_single(value).map_err(Error::host)
}

/// `[single]$value` as the value a COM property is set to.
fn r4(value: &Value) -> Result<Com> {
    Ok(Com::R4(cast_single(value)?))
}

/// `Color-Value ([string]$value)`.
fn color_of(value: &Value) -> Result<Com> {
    Ok(Com::I4(convert::color_value(&text_of(value)).map_err(Error::host)?))
}

/// `if ($value) { on } else { 0 }`: the codes Word's flags take (-1 and 0, 1 and 0).
fn flag(value: &Value, on: i32) -> Com {
    Com::I4(if truthy(value) { on } else { 0 })
}

/// `[ordered]@{ ... }`.
fn ordered(pairs: Vec<(&str, Value)>) -> Value {
    Value::object(ObjectKind::Ordered, pairs)
}

/// `[int]$doc.Paragraphs.Count`.
fn count_of(document: &Obj) -> Result<i32> {
    count_of_collection(&document.get("Paragraphs")?)
}

/// A paragraph the formatting is applied to: a Word paragraph, or the stand-in object (`Range`, `Format`, `Borders`) a run of
/// appended paragraphs is formatted through, whose members are already read.
#[derive(Clone)]
enum Para {
    Real(Com),
    Block { range: Com, format: Com, borders: Com },
}

impl Para {
    /// `$paragraph.Range`.
    fn range(&self) -> Result<Com> {
        match self {
            Para::Real(paragraph) => paragraph.member("Range"),
            Para::Block { range, .. } => Ok(range.clone()),
        }
    }

    /// `$paragraph.Format`.
    fn format(&self) -> Result<Com> {
        match self {
            Para::Real(paragraph) => paragraph.member("Format"),
            Para::Block { format, .. } => Ok(format.clone()),
        }
    }

    /// `$paragraph.Borders`.
    fn borders(&self) -> Result<Com> {
        match self {
            Para::Real(paragraph) => paragraph.member("Borders"),
            Para::Block { borders, .. } => Ok(borders.clone()),
        }
    }
}

/// `Invoke-WordOperation`: the operation's structured result.
fn invoke(document: &Obj, op: &Value) -> Result<Value> {
    let name = lower(&text_of(&prop(op, "op")));
    match name.as_str() {
        "fill_template" => template::fill_template(document, op),
        "replace_text" => text::replace_text(document, op),
        "append_text" => text::append_text(document, op),
        "set_table_cell" => tables::set_table_cell(document, op),
        "add_table" => tables::add_table(document, op),
        "set_table_style" => tables::set_table_style(document, op),
        "merge_table_cells" => tables::merge_table_cells(document, op),
        "set_table_cell_style" => tables::set_table_cell_style(document, op),
        "set_paragraph_text" => text::set_paragraph_text(document, op),
        "remove_paragraph" => text::remove_paragraph(document, op),
        "move_paragraph" => text::move_paragraph(document, op),
        "add_image" => text::add_image(document, op),
        "add_comment" => review::add_comment(document, op),
        "add_comment_reply" => review::add_comment_reply(document, op),
        "add_provenance" => review::add_provenance(document, op),
        "delete_comment" => review::delete_comment(document, op),
        "set_comment_resolved" => review::set_comment_resolved(document, op),
        "set_document_font" => styles::set_document_font(document, op),
        "define_styles" => styles::define_styles(document, op),
        "set_font" => styles::set_font(document, op),
        "set_paragraph_style" => styles::set_paragraph_style(document, op),
        "set_paragraph_format" => styles::set_paragraph_format(document, op),
        "insert_table_row" => tables::insert_table_row(document, op),
        "delete_table_row" => tables::delete_table_row(document, op),
        "insert_table_column" => tables::insert_table_column(document, op),
        "delete_table_column" => tables::delete_table_column(document, op),
        "set_header_footer" => structure::set_header_footer(document, op),
        "track_changes" => review::track_changes(document, op),
        "normalize_runs" => Ok(review::normalize_runs()),
        "resolve_revisions" => review::resolve_revisions(document, op),
        "resolve_revision" => review::resolve_revision(document, op),
        "insert_toc" => structure::insert_toc(document, op),
        "add_page_numbers" => structure::add_page_numbers(document, op),
        "insert_break" => structure::insert_break(document, op),
        "set_list" => styles::set_list(document, op),
        "add_hyperlink" => structure::add_hyperlink(document, op),
        "add_bookmark" => structure::add_bookmark(document, op),
        "set_content_control" => structure::set_content_control(document, op),
        "add_note" => structure::add_note(document, op),
        "set_page" => structure::set_page(document, op),
        "fit_table" => tables::fit_table(document, op),
        _ => Err(Error::host(format!("Unsupported DOCX operation: {}", text_of(&prop(op, "op"))))),
    }
}

impl FormatEditor for Editor {
    fn apply_operation(&self, _context: &mut EditContext<'_>, document: &Obj, op: &Value, _live: bool, _allow_ui_activation: bool) -> Result<Option<Value>> {
        author::with_author(document, op, || invoke(document, op)).map(Some)
    }

    fn operation_names(&self) -> &'static [&'static str] {
        OPERATIONS
    }

    fn append_run_length(&self, _context: &mut EditContext<'_>, document: &Obj, queue: &[Value], position: usize) -> Result<usize> {
        append::run_length(document, queue, position)
    }

    fn apply_append_run(&self, _context: &mut EditContext<'_>, document: &Obj, run: &[Value]) -> Result<Vec<Value>> {
        append::apply_run(document, run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_editor_serves_the_registrys_forty_one_docx_operations_once_each() {
        let mut names: Vec<&str> = OPERATIONS.to_vec();
        assert_eq!(names.len(), 41);
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 41);
        assert_eq!(Editor.operation_names(), OPERATIONS);
    }

    #[test]
    fn a_flag_is_the_code_word_takes() {
        assert_eq!(flag(&Value::Bool(true), -1), Com::I4(-1));
        assert_eq!(flag(&Value::Bool(true), 1), Com::I4(1));
        assert_eq!(flag(&Value::Null, -1), Com::I4(0));
    }

    #[test]
    fn a_colour_is_refused_with_the_scripts_text() {
        assert_eq!(color_of(&Value::string("12")).unwrap_err().message(), "Invalid color '12'; expected RRGGBB");
    }
}
