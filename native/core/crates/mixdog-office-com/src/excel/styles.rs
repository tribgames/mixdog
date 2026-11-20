//! The style of a cell as the snapshot reports it (`Excel-HorizontalAlignmentName`, `Excel-CellStyle`,
//! `Excel-SharedCellStyle`, `Excel-ColumnCellStyles`, `Excel-DefaultStyle`).

use std::collections::HashMap;

use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::Value;

use super::cells::attempt;
use super::cells::bool_of;
use super::cells::double_of;
use super::cells::get_with;
use super::cells::int_of;
use super::cells::is_null_or_dbnull;
use super::cells::ordered;
use super::cells::string_of;
use super::numfmt::english_number_format;

/// A cell's own horizontal alignment in the portable reader's words; `None` for Excel's General (the cell states none),
/// which the portable reader leaves out too.
pub(super) fn horizontal_alignment_name(value: &Com) -> Result<Option<&'static str>> {
    Ok(match int_of(value)? {
        -4131 => Some("left"),
        -4108 => Some("center"),
        -4152 => Some("right"),
        -4130 => Some("justify"),
        7 => Some("centerContinuous"),
        -4117 => Some("distributed"),
        5 => Some("fill"),
        _ => None,
    })
}

/// The values a style is made of, as the properties answered them.
struct Parts<'a> {
    name: &'a Com,
    size: &'a Com,
    bold: &'a Com,
    italic: &'a Com,
    color: &'a Com,
    fill: &'a Com,
}

fn style_object(parts: &Parts<'_>, number_format: String, alignment: Option<&'static str>) -> Result<Value> {
    let mut pairs = vec![
        ("fontName", Value::String(string_of(parts.name))),
        ("fontSize", Value::Double(double_of(parts.size)?)),
        ("bold", Value::Bool(bool_of(parts.bold))),
        ("italic", Value::Bool(bool_of(parts.italic))),
        ("color", Value::Double(double_of(parts.color)?)),
        ("fillColor", Value::Double(double_of(parts.fill)?)),
        ("numberFormat", Value::String(number_format)),
    ];
    if let Some(alignment) = alignment {
        pairs.push(("horizontalAlignment", Value::string(alignment)));
    }
    Ok(ordered(pairs))
}

/// `Excel-CellStyle`: one cell's style.
pub(super) fn cell_style(cell: &Com) -> Result<Value> {
    let font = cell.member("Font")?;
    let name = font.member("Name")?;
    let size = font.member("Size")?;
    let bold = font.member("Bold")?;
    let italic = font.member("Italic")?;
    let color = font.member("Color")?;
    let fill = cell.member("Interior")?.member("Color")?;
    // The members of the host's dictionary literal are evaluated in order; each cast follows its read there, and the
    // number format is read last.
    let number_format = english_number_format(cell, None)?;
    let alignment = attempt(|| horizontal_alignment_name(&cell.member("HorizontalAlignment")?)).flatten();
    style_object(&Parts { name: &name, size: &size, bold: &bold, italic: &italic, color: &color, fill: &fill }, number_format, alignment)
}

/// `Excel-SharedCellStyle`: the style every cell of a block shares, or `None` when they differ (Excel answers a mixed
/// range's property with nothing). Asked in the order a table's column most often differs in (the header's format, weight
/// and fill), so a mixed block costs a call or two.
pub(super) fn shared_cell_style(range: &Com) -> Result<Option<Value>> {
    let format = range.member("NumberFormat")?;
    if is_null_or_dbnull(&format) {
        return Ok(None);
    }
    let font = range.member("Font")?;
    let bold = font.member("Bold")?;
    if is_null_or_dbnull(&bold) {
        return Ok(None);
    }
    let fill = range.member("Interior")?.member("Color")?;
    if is_null_or_dbnull(&fill) {
        return Ok(None);
    }
    let size = font.member("Size")?;
    if is_null_or_dbnull(&size) {
        return Ok(None);
    }
    let name = font.member("Name")?;
    if is_null_or_dbnull(&name) {
        return Ok(None);
    }
    let color = font.member("Color")?;
    if is_null_or_dbnull(&color) {
        return Ok(None);
    }
    let italic = font.member("Italic")?;
    if is_null_or_dbnull(&italic) {
        return Ok(None);
    }
    let horizontal = range.member("HorizontalAlignment")?;
    if is_null_or_dbnull(&horizontal) {
        return Ok(None);
    }
    let number_format = english_number_format(range, Some(&string_of(&format)))?;
    let alignment = horizontal_alignment_name(&horizontal)?;
    style_object(&Parts { name: &name, size: &size, bold: &bold, italic: &italic, color: &color, fill: &fill }, number_format, alignment).map(Some)
}

/// `Excel-ColumnCellStyles`: the styles of one column's populated cells (`rows`: their sheet rows, ascending, of which
/// `from..=to` are asked) into `styles` by address. A table's column shares one style below its header, so a block whose
/// cells differ is halved until they agree or one cell is left, and that cell is read on its own.
pub(super) fn column_cell_styles(sheet: &Com, letters: &str, rows: &[i32], styles: &mut HashMap<String, Value>, from: usize, to: usize) -> Result<()> {
    let cell_at = |row: i32| get_with(sheet, "Range", &[Com::Str(format!("{letters}{row}"))]);
    if from == to {
        let style = cell_style(&cell_at(rows[from])?)?;
        styles.insert(format!("{letters}{}", rows[from]), style);
        return Ok(());
    }
    let block = get_with(sheet, "Range", &[Com::Str(format!("{letters}{}:{letters}{}", rows[from], rows[to]))])?;
    if let Some(shared) = shared_cell_style(&block)? {
        for row in &rows[from..=to] {
            styles.insert(format!("{letters}{row}"), shared.clone());
        }
        return Ok(());
    }
    let middle = (from + to) / 2;
    column_cell_styles(sheet, letters, rows, styles, from, middle)?;
    column_cell_styles(sheet, letters, rows, styles, middle + 1, to)
}

/// `Excel-DefaultStyle`: the workbook's Normal style, what every unstyled cell renders with, as the portable reader reports
/// it (cellXfs 0); `$null` when it cannot be read.
pub(super) fn default_style(book: &Com) -> Value {
    let read = || -> Result<Value> {
        let styles = book.member("Styles")?;
        let font = get_with(&styles, "Item", &[Com::Str("Normal".to_owned())])?.member("Font")?;
        let name = string_of(&font.member("Name")?);
        let size = double_of(&font.member("Size")?)?;
        Ok(ordered(vec![("fontName", Value::String(name)), ("fontSize", Value::Double(size))]))
    };
    read().unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alignment_codes_read_as_the_portable_readers_words() {
        assert_eq!(horizontal_alignment_name(&Com::I4(-4131)).unwrap(), Some("left"));
        assert_eq!(horizontal_alignment_name(&Com::I4(7)).unwrap(), Some("centerContinuous"));
        assert_eq!(horizontal_alignment_name(&Com::I4(1)).unwrap(), None);
        assert!(horizontal_alignment_name(&Com::Null).is_err());
    }
}
