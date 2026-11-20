//! `set_style` (fonts, fills, alignment, indent, borders), `Set-ExcelAlignmentKeepingIndent`, `merge_cells`, `unmerge_cells`.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::excel::cells::attempt;
use crate::excel::cells::get_with;
use crate::excel::cells::items_of;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::text;

use super::com_text;
use super::double_cast;
use super::equals_bool;
use super::flag;
use super::int_cast;
use super::int_of_com;
use super::present;
use super::prop;
use super::range_of;
use super::record_of;
use super::sheets::excel_sheet;
use super::single_cast;
use super::text_of;
use super::values::set_number_format;

/// `Color-Value` as an Int32 argument.
fn color_of(hex: &str) -> Result<Com> {
    convert::color_value(hex).map(Com::I4).map_err(Error::host)
}

/// `$props.Name` of the properties object (`$null` when there is none).
fn member(props: &Value, name: &str) -> Value {
    payload::property(props, name)
}

/// `@($props.PSObject.Properties.Name) -contains $name`.
fn has_property(props: &Value, name: &str) -> bool {
    match props {
        Value::Object(object) => object.get(name).is_some(),
        _ => false,
    }
}

/// `Set-ExcelAlignmentKeepingIndent`: Excel sets a range's vertical alignment or wrap as one alignment for all its cells, and in a
/// range whose cells are indented differently every indent goes with it. A range of one indent is set whole, one of mixed
/// indents a column at a time, and a column of mixed indents a cell at a time.
fn keep_indent(range: &Com, apply: &dyn Fn(&Com) -> Result<()>) -> Result<()> {
    let is_number = |value: &Com| matches!(value, Com::I4(_) | Com::R8(_));
    if is_number(&range.member("IndentLevel")?) {
        return apply(range);
    }
    for column in items_of(&range.member("Columns")?)? {
        if is_number(&column.member("IndentLevel")?) {
            apply(&column)?;
            continue;
        }
        for cell in items_of(&column.member("Cells")?)? {
            apply(&cell)?;
        }
    }
    Ok(())
}

/// The horizontal alignment names of the portable writer (centre, middle, general, fill, distributed) mean the same here.
fn horizontal_code(name: &str) -> i32 {
    match text::to_lower_invariant(name).as_str() {
        "center" | "centre" => -4108,
        "right" => -4152,
        "justify" => -4130,
        "fill" => 5,
        "distributed" => -4117,
        "general" => 1,
        _ => -4131,
    }
}

fn vertical_code(name: &str) -> i32 {
    match text::to_lower_invariant(name).as_str() {
        "center" | "centre" | "middle" => -4108,
        "bottom" => -4107,
        "justify" => -4130,
        "distributed" => -4117,
        _ => -4160,
    }
}

fn line_style_code(style: &str) -> i32 {
    match text::to_lower_invariant(style).as_str() {
        "dashed" => -4115,
        "dotted" => -4118,
        "double" => -4119,
        _ => 1,
    }
}

fn weight_code(style: &str) -> i32 {
    match text::to_lower_invariant(style).as_str() {
        "hair" => 1,
        "medium" => -4138,
        "thick" => 4,
        _ => 2,
    }
}

/// `set_style`.
pub(super) fn set_style(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let address = if flag(op, "range") { text_of(op, "range") } else { text_of(op, "cell") };
    let target = range_of(&sheet, &address)?;
    let props = prop(op, "properties");
    if flag(&props, "fontName") {
        target.member("Font")?.set_member("Name", com_text(text_of(&props, "fontName")))?;
    }
    if flag(&props, "fontSize") {
        target.member("Font")?.set_member("Size", Com::R4(single_cast(&member(&props, "fontSize"))?))?;
    }
    if present(&props, "bold") {
        target.member("Font")?.set_member("Bold", Com::Bool(convert::to_bool(&member(&props, "bold"))))?;
    }
    if present(&props, "italic") {
        target.member("Font")?.set_member("Italic", Com::Bool(convert::to_bool(&member(&props, "italic"))))?;
    }
    if flag(&props, "numberFormat") {
        set_number_format(&target, &text_of(&props, "numberFormat"))?;
    }
    if flag(&props, "color") {
        let color = color_of(&text_of(&props, "color"))?;
        target.member("Font")?.set_member("Color", color)?;
    }
    // null takes the fill away (xlColorIndexNone), as the portable writer drops the cell's fill for it.
    if has_property(&props, "fillColor") && !present(&props, "fillColor") {
        target.member("Interior")?.set_member("ColorIndex", Com::I4(-4142))?;
    } else if flag(&props, "fillColor") {
        let color = color_of(&text_of(&props, "fillColor"))?;
        target.member("Interior")?.set_member("Color", color)?;
    }
    if flag(&props, "horizontalAlignment") {
        target.set_member("HorizontalAlignment", Com::I4(horizontal_code(&text_of(&props, "horizontalAlignment"))))?;
    }
    if flag(&props, "verticalAlignment") {
        let vertical = vertical_code(&text_of(&props, "verticalAlignment"));
        keep_indent(&target, &|part| part.set_member("VerticalAlignment", Com::I4(vertical)))?;
    }
    if present(&props, "wrapText") {
        let wrap = convert::to_bool(&member(&props, "wrapText"));
        keep_indent(&target, &|part| part.set_member("WrapText", Com::Bool(wrap)))?;
    }
    if present(&props, "indent") {
        set_indent(&target, &props)?;
    }
    if present(&props, "locked") {
        target.set_member("Locked", Com::Bool(convert::to_bool(&member(&props, "locked"))))?;
    }
    if flag(&props, "borders") {
        set_borders(&target, &member(&props, "borders"))?;
    }
    Ok(record_of("set_style", true, Vec::new()))
}

/// The indent: the portable writer's rule is that an indented cell with no alignment of its own is set left.
fn set_indent(target: &Com, props: &Value) -> Result<()> {
    let rounded = convert::round(double_cast(&member(props, "indent"))?);
    let level = int_cast(&Value::Double(rounded))?.clamp(0, 15);
    if level > 0 && !flag(props, "horizontalAlignment") && attempt(|| int_of_com(&target.member("HorizontalAlignment")?)).unwrap_or(0) == 1 {
        target.set_member("HorizontalAlignment", Com::I4(-4131))?;
    }
    target.set_member("IndentLevel", Com::I4(level))
}

/// The four edges as the portable writer's border element: one spec for every side, or a spec per side; a side named none is
/// cleared, a side not named keeps what the cell had.
fn set_borders(target: &Com, borders: &Value) -> Result<()> {
    let side_index = |side: &str| match side {
        "left" => 7,
        "top" => 8,
        "bottom" => 9,
        _ => 10,
    };
    let names_a_side = match borders {
        Value::Object(object) => object.entries.iter().any(|(name, _)| ["left", "top", "bottom", "right"].iter().any(|side| payload::names_equal(name, side))),
        _ => false,
    };
    let uniform = !names_a_side;
    for side in ["left", "top", "bottom", "right"] {
        let spec = if uniform { borders.clone() } else { member(borders, side) };
        if spec.is_null() {
            continue;
        }
        let style = match &spec {
            Value::String(style) => style.clone(),
            other if flag(other, "style") => text_of(other, "style"),
            _ => "thin".to_owned(),
        };
        let clear = equals_bool(&spec, false)
            || convert::equals(&Value::String(style.clone()), &Value::string("none"))
            || equals_bool(&member(&spec, "enabled"), false);
        // The portable writer rules every cell of the range, so the lines between its cells are drawn too: the edge index alone
        // boxed a block the file writer drew as a grid. One side cleared alone leaves the lines between cells, as there each
        // neighbour keeps its opposite side.
        let borders_of = target.member("Borders")?;
        let mut edges = vec![get_with(&borders_of, "Item", &[Com::I4(side_index(side))])?];
        let inside = if side == "left" || side == "right" { 11 } else { 12 };
        let across = int_of_com(&target.member(if inside == 11 { "Columns" } else { "Rows" })?.member("Count")?)?;
        if across > 1 && (uniform || !clear) {
            edges.push(get_with(&target.member("Borders")?, "Item", &[Com::I4(inside)])?);
        }
        for edge in &edges {
            if clear {
                edge.set_member("LineStyle", Com::I4(-4142))?;
                continue;
            }
            edge.set_member("LineStyle", Com::I4(line_style_code(&style)))?;
            edge.set_member("Weight", Com::I4(weight_code(&style)))?;
            if !matches!(spec, Value::String(_)) && flag(&spec, "color") {
                edge.set_member("Color", color_of(&text_of(&spec, "color"))?)?;
            }
        }
    }
    Ok(())
}

/// `merge_cells`.
pub(super) fn merge_cells(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    range_of(&sheet, &text_of(op, "range"))?.call_member("Merge", &[])?;
    Ok(record_of("merge_cells", true, vec![("range", Value::String(text_of(op, "range")))]))
}

/// `unmerge_cells`.
pub(super) fn unmerge_cells(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    range_of(&sheet, &text_of(op, "range"))?.call_member("UnMerge", &[])?;
    Ok(record_of("unmerge_cells", true, vec![("range", Value::String(text_of(op, "range")))]))
}
