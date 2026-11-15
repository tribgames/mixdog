//! `Apply-PowerPointOperation` of `office-com-host.ps1`: the 46 operations on a deck, registered as the `pptx`
//! [`FormatEditor`].
//!
//! * [`layout`]: `PowerPoint-Layout`, a layout by index, name or type.
//! * [`text`]: `replace_text`, `set_text`, `fit_text` and the text helpers (paragraphs, alignment, anchor, font faces).
//! * [`shapes`]: text boxes and shapes, their shadow, `Clamp-Unit`, deleting, stacking, aligning, grouping, hyperlinks and the
//!   ink a fill carries.
//! * [`tables`]: `add_table`, `set_table_data` and `set_table_cell_style`.
//! * [`images`]: `Add-PptImage` and the picture and media operations.
//! * [`slides`]: the slide operations, notes, comments and provenance.
//! * [`footer`]: the footer and the slide number.
//! * [`template`]: `fill_template` over the text ranges of a deck.
//! * [`chart_data`]: the chart data sheet, the Excel it starts and its cleanup.
//! * [`chart_window`]: the hidden window a chart needs.
//! * [`charts`]: the chart operations.
//!
//! Every operation answers one record in the key order the script writes it, and a refusal is the script's text. A property
//! read of the request is a PowerShell property read (a missing one is `$null`), a cast is PowerShell's cast, and a step the
//! script wraps in `try { } catch { }` is wrapped here and its failure ignored: the replayed call logs hold the port to the same
//! calls in the same order.

pub(crate) mod chart_data;
pub(crate) mod chart_window;
pub(crate) mod charts;
pub(crate) mod footer;
pub(crate) mod images;
pub(crate) mod layout;
pub(crate) mod shapes;
pub(crate) mod slides;
pub(crate) mod tables;
pub(crate) mod template;
pub(crate) mod text;

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

use super::as_value;

/// The editor of `.pptx` documents.
pub struct Editor;

/// The operations of the editor, in the order of `tests/fixtures/registry/operations.json`.
const OPERATIONS: [&str; 46] = [
    "add_animation",
    "add_chart",
    "add_comment",
    "add_image",
    "add_media",
    "add_provenance",
    "add_shape",
    "add_slide",
    "add_table",
    "add_textbox",
    "align_shapes",
    "apply_theme",
    "crop_image",
    "delete_comment",
    "delete_shape",
    "delete_slide",
    "distribute_shapes",
    "duplicate_slide",
    "fill_template",
    "fit_text",
    "group_shapes",
    "import_slides",
    "keep_slides",
    "move_slide",
    "replace_image",
    "replace_text",
    "set_chart_axis",
    "set_chart_data",
    "set_chart_data_labels",
    "set_chart_error_bars",
    "set_chart_series",
    "set_chart_trendline",
    "set_footer",
    "set_hyperlink",
    "set_layout",
    "set_notes",
    "set_shape",
    "set_slide_background",
    "set_slide_number",
    "set_slide_visibility",
    "set_table_cell_style",
    "set_table_data",
    "set_text",
    "set_transition",
    "ungroup_shape",
    "z_order",
];

impl FormatEditor for Editor {
    fn apply_operation(
        &self,
        context: &mut EditContext<'_>,
        document: &Obj,
        op: &Value,
        _live: bool,
        allow_ui_activation: bool,
    ) -> Result<Option<Value>> {
        apply_powerpoint_operation(context, &as_value(document), op, allow_ui_activation).map(Some)
    }

    fn operation_names(&self) -> &'static [&'static str] {
        &OPERATIONS
    }
}

/// `Apply-PowerPointOperation`: the operation by name (`switch` compares strings ignoring case), its record.
fn apply_powerpoint_operation(context: &mut EditContext<'_>, presentation: &Com, op: &Value, allow_ui: bool) -> Result<Value> {
    let requested = text_of(&prop(op, "op"));
    let name = OPERATIONS.iter().copied().find(|known| payload::names_equal(known, &requested));
    match name {
        Some("fill_template") => template::fill_powerpoint_template(presentation, op),
        Some("replace_text") => text::replace_text(presentation, op),
        Some("set_text") => text::set_text(presentation, op),
        Some("fit_text") => text::fit_text(presentation, op),
        Some("add_slide") => slides::add_slide(presentation, op),
        Some("delete_slide") => slides::delete_slide(presentation, op),
        Some("move_slide") => slides::move_slide(presentation, op),
        Some("duplicate_slide") => slides::duplicate_slide(presentation, op),
        Some("import_slides") => slides::import_slides(presentation, op),
        Some("keep_slides") => slides::keep_slides(presentation, op),
        Some("set_slide_visibility") => slides::set_slide_visibility(presentation, op),
        Some("set_transition") => slides::set_transition(presentation, op),
        Some("add_animation") => slides::add_animation(presentation, op),
        Some("set_slide_background") => slides::set_slide_background(presentation, op),
        Some("set_layout") => slides::set_layout(presentation, op),
        Some("apply_theme") => slides::apply_theme(presentation, op),
        Some("set_notes") => slides::set_notes(presentation, op),
        Some("add_comment") => slides::add_comment(presentation, op),
        Some("delete_comment") => slides::delete_comment(presentation, op),
        Some("add_provenance") => slides::add_provenance(presentation, op),
        Some("delete_shape") => shapes::delete_shape(presentation, op),
        Some("add_textbox") => shapes::add_textbox(presentation, op),
        Some("add_shape") => shapes::add_shape(presentation, op),
        Some("set_shape") => shapes::set_shape(presentation, op),
        Some("set_hyperlink") => shapes::set_hyperlink(presentation, op),
        Some("z_order") => shapes::z_order(presentation, op),
        Some("align_shapes") => shapes::align_shapes(presentation, op),
        Some("distribute_shapes") => shapes::distribute_shapes(presentation, op),
        Some("group_shapes") => shapes::group_shapes(presentation, op),
        Some("ungroup_shape") => shapes::ungroup_shape(presentation, op),
        Some("add_table") => tables::add_table(presentation, op),
        Some("set_table_data") => tables::set_table_data(presentation, op),
        Some("set_table_cell_style") => tables::set_table_cell_style(presentation, op),
        Some("add_image") => images::add_image(presentation, op),
        Some("replace_image") => images::replace_image(presentation, op),
        Some("crop_image") => images::crop_image(presentation, op),
        Some("add_media") => images::add_media(presentation, op),
        Some("set_footer") => footer::set_footer(presentation, op),
        Some("set_slide_number") => footer::set_slide_number(presentation, op),
        Some("add_chart") => charts::add_chart(context, presentation, op, allow_ui),
        Some("set_chart_data") => charts::set_chart_data(context, presentation, op),
        Some("set_chart_series") => charts::set_chart_series(presentation, op),
        Some("set_chart_axis") => charts::set_chart_axis(presentation, op),
        Some("set_chart_trendline") => charts::set_chart_trendline(presentation, op),
        Some("set_chart_error_bars") => charts::set_chart_error_bars(presentation, op),
        Some("set_chart_data_labels") => charts::set_chart_data_labels(presentation, op),
        _ => Err(Error::host(format!("Unsupported PPTX operation: {}", text_of(&prop(op, "op"))))),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The request as PowerShell reads it.

/// `$op.name`: `$null` where the request has no such property.
pub(crate) fn prop(op: &Value, name: &str) -> Value {
    payload::property(op, name)
}

/// `Operation-Property $op $name $fallback`.
pub(crate) fn operation_property(op: &Value, name: &str, fallback: Value) -> Value {
    payload::operation_property(op, name, fallback)
}

/// `$value -ne $null`.
pub(crate) fn present(value: &Value) -> bool {
    !value.is_null()
}

/// `[bool]$value` (and `if ($value)`).
pub(crate) fn truthy(value: &Value) -> bool {
    convert::to_bool(value)
}

/// `[string]$value`.
pub(crate) fn text_of(value: &Value) -> String {
    convert::to_ps_string(value)
}

/// A cast's refusal as the host's failure.
pub(crate) fn cast<T>(result: std::result::Result<T, String>) -> Result<T> {
    result.map_err(Error::host)
}

/// `[single]$value`.
pub(crate) fn single(value: &Value) -> Result<f32> {
    cast(convert::to_single(value))
}

/// `[double]$value`.
pub(crate) fn double(value: &Value) -> Result<f64> {
    cast(convert::to_double(value))
}

/// `[int]$value`.
pub(crate) fn int(value: &Value) -> Result<i32> {
    cast(convert::to_int(value))
}

/// `$value -as [int]` when it is a number that is not zero: what `if ($op.shapeType -as [int])` tests.
pub(crate) fn as_int_nonzero(value: &Value) -> Option<i32> {
    convert::as_int(value).filter(|number| *number != 0)
}

/// `@($value)`: an array is its items, anything else (`$null` too) is one item.
pub(crate) fn array_of(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        other => vec![other.clone()],
    }
}

/// `$value | Where-Object { $null -ne $_ }` and the like: an array is its items, `$null` is none, anything else is one item.
/// (A `$null` piped to `ForEach-Object` runs it once: that is [`array_of`].)
pub(crate) fn pipeline(value: &Value) -> Vec<Value> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(items) => items.clone(),
        other => vec![other.clone()],
    }
}

/// `$object.PSObject.Properties.Name -contains $name`.
pub(crate) fn has_property(object: &Value, name: &str) -> bool {
    matches!(object, Value::Object(found) if found.get(name).is_some())
}

/// `[ordered]@{ ... }`.
pub(crate) fn record(pairs: Vec<(&str, Value)>) -> Value {
    Value::object(ObjectKind::Ordered, pairs)
}

// ---------------------------------------------------------------------------------------------------------------------
// COM values as PowerShell passes them.

/// A `[single]` argument (`VT_R4`).
pub(crate) fn r4(number: f32) -> Com {
    Com::R4(number)
}

/// An `[int]` argument (`VT_I4`).
pub(crate) fn i4(number: i32) -> Com {
    Com::I4(number)
}

/// A `[string]` argument.
pub(crate) fn bstr(text: &str) -> Com {
    Com::from(text)
}

/// `$true` or `$false` (`VT_BOOL`).
pub(crate) fn boolean(flag: bool) -> Com {
    Com::Bool(flag)
}

/// PowerPoint's own true (-1) and false (0), as the script writes them into `Visible`, `Bold` and the like.
pub(crate) fn office_flag(flag: bool) -> Com {
    Com::I4(if flag { -1 } else { 0 })
}

/// `Color-Value ([string]$value)`.
pub(crate) fn color(value: &Value) -> Result<Com> {
    color_text(&text_of(value))
}

/// `Color-Value $hex`.
pub(crate) fn color_text(hex: &str) -> Result<Com> {
    cast(convert::color_value(hex)).map(Com::I4)
}

/// `[string]$value` of a COM value.
pub(crate) fn string_value(value: &Com) -> String {
    super::string_of(value)
}

/// `[int]$value` of a COM value.
pub(crate) fn int_value(value: &Com) -> Result<i32> {
    super::int_of(value)
}

/// `[single]$value` of a COM value.
pub(crate) fn single_value(value: &Com) -> Result<f32> {
    super::single_of(value)
}

/// `[double]$value` of a COM value.
pub(crate) fn double_value(value: &Com) -> Result<f64> {
    super::double_of(value)
}

/// `$value.A.B.C`: a chain of property reads (`$null` ends it).
pub(crate) fn walk(value: &Com, names: &[&str]) -> Result<Com> {
    let mut current = value.clone();
    for name in names {
        current = current.member(name)?;
    }
    Ok(current)
}

/// `$value.A.B.C = $x`: the chain, then the assignment to its last name.
pub(crate) fn put_path(value: &Com, names: &[&str], assigned: Com) -> Result<()> {
    let Some((last, parents)) = names.split_last() else { return Ok(()) };
    walk(value, parents)?.set_member(last, assigned)
}

/// `[int]$collection.Count` of a COM value.
pub(crate) fn count(collection: &Com) -> Result<i32> {
    int_value(&collection.member("Count")?)
}

/// `@($collection)`: every item of a COM collection.
pub(crate) fn items(collection: &Com) -> Result<Vec<Com>> {
    crate::actions::document::items_of(collection)
}

/// `$collection.Item($index)`.
pub(crate) fn item(collection: &Com, index: i32) -> Result<Com> {
    crate::office::item_of(collection, index)
}

/// `<collection>.Item($index)` in a chain: a parameterized property read, as [`item`] is.
pub(crate) trait ItemAt {
    fn item_at(&self, index: i32) -> Result<Com>;
}

impl ItemAt for Com {
    fn item_at(&self, index: i32) -> Result<Com> {
        item(self, index)
    }
}

/// `try { <step> } catch {}`: the failure is ignored, whatever the step did before it stays done.
pub(crate) fn attempt(step: impl FnOnce() -> Result<()>) {
    let _ = step();
}

/// `$presentation.Slides.Item([int]$op.slide)` (`Ppt-Slide`).
pub(crate) fn slide_of(presentation: &Com, op: &Value) -> Result<Com> {
    let index = int(&prop(op, "slide"))?;
    presentation.member("Slides")?.item_at(index)
}

/// `$slide.Shapes.Item([int]$op.shape)`.
pub(crate) fn shape_of(slide: &Com, op: &Value) -> Result<Com> {
    let index = int(&prop(op, "shape"))?;
    slide.member("Shapes")?.item_at(index)
}

/// `[int]$slide.SlideIndex`.
pub(crate) fn slide_index(slide: &Com) -> Result<i32> {
    int_value(&slide.member("SlideIndex")?)
}

/// A box of the request: `[single](Operation-Property $op $name $fallback)`.
pub(crate) fn box_value(op: &Value, name: &str, fallback: i32) -> Result<f32> {
    single(&operation_property(op, name, Value::Int(fallback)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_editor_serves_the_46_operations_of_the_registry_in_order() {
        assert_eq!(Editor.operation_names().len(), 46);
        let mut sorted = OPERATIONS;
        sorted.sort_unstable();
        assert_eq!(sorted, OPERATIONS);
    }

    #[test]
    fn an_array_of_null_is_one_null_and_a_pipeline_of_null_is_none() {
        assert_eq!(array_of(&Value::Null), vec![Value::Null]);
        assert!(pipeline(&Value::Null).is_empty());
        assert_eq!(pipeline(&Value::Int(3)), vec![Value::Int(3)]);
    }

    #[test]
    fn a_shape_type_that_is_zero_or_not_a_number_is_not_an_integer() {
        assert_eq!(as_int_nonzero(&Value::string("7")), Some(7));
        assert_eq!(as_int_nonzero(&Value::string("0")), None);
        assert_eq!(as_int_nonzero(&Value::string("star")), None);
    }
}
