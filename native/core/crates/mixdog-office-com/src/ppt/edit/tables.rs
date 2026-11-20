//! The table operations of the deck editor: `add_table`, `set_table_data` and `set_table_cell_style`.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::ppt::truth;
use crate::ps::Value;
use crate::ps::text;

use super::ItemAt;
use super::array_of;
use super::attempt;
use super::boolean;
use super::box_value;
use super::bstr;
use super::color;
use super::color_text;
use super::count;
use super::double;
use super::double_value;
use super::has_property;
use super::i4;
use super::int;
use super::int_value;
use super::office_flag;
use super::pipeline;
use super::present;
use super::prop;
use super::put_path;
use super::r4;
use super::record;
use super::shape_of;
use super::single;
use super::slide_index;
use super::slide_of;
use super::string_value;
use super::text::paragraph_alignment;
use super::text::set_font_name;
use super::text::vertical_anchor;
use super::text_of;
use super::truthy;
use super::walk;

/// The unit words that may follow a figure: `% x X K M B T` and the Korean units 배 건 억 조 만 천 원 시간 일 개월 개 명 대 곳 분 초 회 점 년,
/// kept as code points.
const FIGURE: &str = "^[\\s~+\\-\\u2212\\u2013$\\u20AC\\u20A9\\u00A3(]*[\\d.,]+\\s*(?:[%xXKMBT]|\\uBC30|\\uAC74|\\uC5B5|\\uC870|\\uB9CC|\\uCC9C|\\uC6D0|\\uC2DC\\uAC04|\\uC77C|\\uAC1C\\uC6D4|\\uAC1C|\\uBA85|\\uB300|\\uACF3|\\uBD84|\\uCD08|\\uD68C|\\uC810|\\uB144)*[)]?\\s*$|^[-\\u2013\\u2014]$";

/// `$table.Cell($row, $column).Shape` of a table shape.
fn cell_shape(shape: &Com, row: i32, column: i32) -> Result<Com> {
    shape.member("Table")?.call_member("Cell", &[i4(row), i4(column)])?.member("Shape")
}

/// `$values[$row][$column]` as PowerShell indexes it: an array's element, a string's character, a scalar's only element, and
/// `$null` past the end.
fn indexed(row: &Value, column: usize) -> Value {
    match row {
        Value::Array(items) => items.get(column).cloned().unwrap_or(Value::Null),
        Value::String(text) => text.encode_utf16().nth(column).map_or(Value::Null, |unit| Value::String(String::from_utf16_lossy(&[unit]))),
        Value::Null => Value::Null,
        other => {
            if column == 0 {
                other.clone()
            } else {
                Value::Null
            }
        }
    }
}

/// The value of a table cell: the request's, or the empty text where the request has none (`$row -le $values.Count -and
/// $column -le @($values[$row - 1]).Count`).
fn cell_value(values: &[Value], row: usize, column: usize) -> Value {
    if row <= values.len() && column <= array_of(&values[row - 1]).len() { indexed(&values[row - 1], column - 1) } else { Value::string("") }
}

/// The columns of a table whose body cells are all figures, which stand on the right edge of their column.
fn right_columns(values: &[Value], rows: i32, columns: i32) -> Result<Vec<i32>> {
    let mut found = Vec::new();
    for column in 2..=columns {
        let mut cells: Vec<String> = Vec::new();
        let last = (rows as usize).min(values.len());
        for row in 2..=last {
            let cell = text_of(&indexed(&Value::Array(array_of(&values[row - 1])), column as usize - 1));
            let cell = cell.trim().to_owned();
            if !cell.is_empty() {
                cells.push(cell);
            }
        }
        if cells.is_empty() {
            continue;
        }
        let mut all_figures = true;
        for cell in &cells {
            if text::is_not_match(cell, FIGURE, false).map_err(Error::host)? {
                all_figures = false;
                break;
            }
        }
        if all_figures {
            found.push(column);
        }
    }
    Ok(found)
}

/// `add_table`: the unstyled portable table (no theme style, a rule under the header, hairlines between the rows, figures on
/// the right edge of their column), proportional column widths, centred cells, and the rules applied in a second pass on both
/// cells that share an edge.
pub(crate) fn add_table(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let values = array_of(&prop(op, "values"));
    let rows_given = prop(op, "rows");
    let rows = if truthy(&rows_given) { int(&rows_given)? } else { (values.len() as i32).max(1) };
    let columns_given = prop(op, "columns");
    let columns = if truthy(&columns_given) {
        int(&columns_given)?
    } else if !values.is_empty() {
        (array_of(&values[0]).len() as i32).max(1)
    } else {
        1
    };
    let left = box_value(op, "left", 72)?;
    let top = box_value(op, "top", 72)?;
    let width = box_value(op, "width", 480)?;
    let height = box_value(op, "height", 180)?;
    let shape = slide.member("Shapes")?.call_member("AddTable", &[i4(rows), i4(columns), r4(left), r4(top), r4(width), r4(height)])?;
    // The portable writer's unstyled table: no theme style (PowerPoint's default banded blue).
    attempt(|| shape.member("Table")?.call_member("ApplyStyle", &[bstr("{2D5ABB26-0587-4C30-8999-92F81FD0307C}"), boolean(false)]).map(|_| ()));
    let figure_columns = right_columns(&values, rows, columns)?;
    let properties = prop(op, "properties");
    // columnWidths share the frame's width in their proportions, as the portable writer's grid does.
    let declared: Vec<f64> = pipeline(&prop(&properties, "columnWidths")).iter().filter(|width| present(width)).map(double).collect::<Result<_>>()?;
    let declared_sum: f64 = declared.iter().sum();
    if declared.len() as i32 == columns && declared_sum > 0.0 && declared.iter().all(|width| *width > 0.0) {
        for column in 1..=columns {
            let share = (f64::from(width) * declared[column as usize - 1] / declared_sum) as f32;
            walk(&shape, &["Table", "Columns"])?.item_at(column)?.set_member("Width", r4(share))?;
        }
    }
    let header_height = prop(&properties, "headerRowHeight");
    if truthy(&header_height) {
        walk(&shape, &["Table", "Rows"])?.item_at(1)?.set_member("Height", r4(single(&header_height)?))?;
    }
    let body_height = prop(&properties, "bodyRowHeight");
    if truthy(&body_height) {
        for row in 2..=rows {
            walk(&shape, &["Table", "Rows"])?.item_at(row)?.set_member("Height", r4(single(&body_height)?))?;
        }
    }
    for row in 1..=rows {
        for column in 1..=columns {
            let value = cell_value(&values, row as usize, column as usize);
            let cell = cell_shape(&shape, row, column)?;
            walk(&cell, &["TextFrame", "TextRange"])?.set_member("Text", bstr(&text_of(&value)))?;
            // Centred in its row, as the portable writer anchors a cell: top-anchored, a row taller than its line left the
            // text against the rule above it.
            attempt(|| put_path(&cell, &["TextFrame", "VerticalAnchor"], i4(3)));
            let font_name = prop(&properties, "fontName");
            if truthy(&font_name) {
                set_font_name(&walk(&cell, &["TextFrame", "TextRange", "Font"])?, &text_of(&font_name))?;
            }
            let font_size = prop(&properties, "fontSize");
            if truthy(&font_size) {
                put_path(&cell, &["TextFrame", "TextRange", "Font", "Size"], r4(single(&font_size)?))?;
            }
            let ink = prop(&properties, "color");
            if truthy(&ink) {
                put_path(&cell, &["TextFrame", "TextRange", "Font", "Color", "RGB"], color(&ink)?)?;
            }
            if row == 1 {
                let header_fill = prop(&properties, "headerFillColor");
                if truthy(&header_fill) {
                    put_path(&cell, &["Fill", "ForeColor", "RGB"], color(&header_fill)?)?;
                }
                let header_ink = prop(&properties, "headerColor");
                if truthy(&header_ink) {
                    put_path(&cell, &["TextFrame", "TextRange", "Font", "Color", "RGB"], color(&header_ink)?)?;
                }
                put_path(&cell, &["TextFrame", "TextRange", "Font", "Bold"], i4(-1))?;
            } else {
                let body_fill = prop(&properties, "bodyFillColor");
                if truthy(&body_fill) {
                    put_path(&cell, &["Fill", "ForeColor", "RGB"], color(&body_fill)?)?;
                }
            }
            if figure_columns.contains(&column) {
                attempt(|| put_path(&cell, &["TextFrame", "TextRange", "ParagraphFormat", "Alignment"], i4(3)));
            }
        }
    }
    // The rules go on once the text is in, as a second pass, and each one on both cells that share the edge (this row's
    // bottom, the next row's top): written per cell while filling, PowerPoint kept only the last row's rule.
    for row in 1..=rows {
        let rule_color = color_text(if row == 1 { "9AA3AD" } else { "D8DCE0" })?;
        let rule_weight = if row == 1 { i4(1) } else { Com::R8(0.5) };
        for column in 1..=columns {
            attempt(|| {
                let mut edges = vec![shape.member("Table")?.call_member("Cell", &[i4(row), i4(column)])?.member("Borders")?.item_at(3)?];
                if row < rows {
                    edges.push(shape.member("Table")?.call_member("Cell", &[i4(row + 1), i4(column)])?.member("Borders")?.item_at(1)?);
                }
                for edge in edges {
                    edge.set_member("Visible", i4(-1))?;
                    edge.set_member("Transparency", i4(0))?;
                    walk(&edge, &["ForeColor"])?.set_member("RGB", rule_color.clone())?;
                    edge.set_member("Weight", rule_weight.clone())?;
                }
                Ok(())
            });
        }
    }
    Ok(record(vec![
        ("op", Value::string("add_table")),
        ("changed", Value::Bool(true)),
        ("shape", Value::String(string_value(&shape.member("Name")?))),
        ("rows", Value::Int(rows)),
        ("columns", Value::Int(columns)),
    ]))
}

/// `[double]$table.Columns.Item($_).Width` for every column.
fn column_widths(table: &Com) -> Result<Vec<f64>> {
    let total = count(&table.member("Columns")?)?;
    let mut widths = Vec::new();
    for column in 1..=total {
        widths.push(double_value(&table.member("Columns")?.item_at(column)?.member("Width")?)?);
    }
    Ok(widths)
}

/// `set_table_data`: the table takes the data's size (rows and columns are added, extra rows removed), the columns it gains
/// share the page's width, and a new row copies the last row's type and fill.
pub(crate) fn set_table_data(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    if !truth(&shape.member("HasTable")?) {
        return Err(Error::host(format!("PowerPoint shape {} is not a table", text_of(&prop(op, "shape")))));
    }
    let values = array_of(&prop(op, "values"));
    let mut available_rows = int_value(&walk(&shape, &["Table", "Rows", "Count"])?)?;
    let mut available_columns = int_value(&walk(&shape, &["Table", "Columns", "Count"])?)?;
    let last_row = available_rows;
    let requested_columns = values.iter().map(|row| array_of(row).len() as i32).fold(0, i32::max);
    while available_rows < values.len() as i32 {
        walk(&shape, &["Table", "Rows"])?.call_member("Add", &[])?;
        available_rows = int_value(&walk(&shape, &["Table", "Rows", "Count"])?)?;
    }
    // The table's width is the page's: the columns it gains share it with the others, as the portable writer sets them,
    // rather than push its edge past the slide's.
    let grew = available_columns < requested_columns;
    let frame_width: f64 = if grew { column_widths(&shape.member("Table")?)?.iter().sum() } else { 0.0 };
    while available_columns < requested_columns {
        walk(&shape, &["Table", "Columns"])?.call_member("Add", &[])?;
        available_columns = int_value(&walk(&shape, &["Table", "Columns", "Count"])?)?;
    }
    if grew {
        let widths = column_widths(&shape.member("Table")?)?;
        let scale = frame_width / widths.iter().sum::<f64>();
        for column in 1..=available_columns {
            let width = (widths.get(column as usize - 1).copied().unwrap_or(0.0) * scale) as f32;
            walk(&shape, &["Table", "Columns"])?.item_at(column)?.set_member("Width", r4(width))?;
        }
    }
    if values.len() as i32 > available_rows || requested_columns > available_columns {
        return Err(Error::host(format!(
            "PowerPoint table shape {} is {available_rows}x{available_columns}, but received {}x{requested_columns}",
            text_of(&prop(op, "shape")),
            values.len()
        )));
    }
    // Fewer rows than the table has: the table shrinks to the data, as the portable writer removes the rows past it, rather
    // than keeping them as blank lines.
    while !values.is_empty() && available_rows > values.len() as i32 {
        walk(&shape, &["Table", "Rows"])?.item_at(available_rows)?.call_member("Delete", &[])?;
        available_rows = int_value(&walk(&shape, &["Table", "Rows", "Count"])?)?;
    }
    for row in 1..=available_rows {
        for column in 1..=available_columns {
            let value = cell_value(&values, row as usize, column as usize);
            let range = walk(&cell_shape(&shape, row, column)?, &["TextFrame", "TextRange"])?;
            range.set_member("Text", bstr(&text_of(&value)))?;
            // A row past the table's edge repeats the last row's type as well as its fill, as the portable writer copies the
            // row: Rows.Add copies the cells but not their runs.
            if row > last_row && int_value(&range.member("Length")?)? > 0 {
                copy_type_of_last_row(&shape, &range, last_row, column)?;
            }
        }
    }
    Ok(record(vec![
        ("op", Value::string("set_table_data")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("rows", Value::Int(available_rows)),
        ("columns", Value::Int(available_columns)),
    ]))
}

/// A new row's cell takes the font, colour and alignment of the cell above it in the last row that was there.
fn copy_type_of_last_row(shape: &Com, range: &Com, last_row: i32, column: i32) -> Result<()> {
    let mut model = walk(&cell_shape(shape, last_row, column)?, &["TextFrame", "TextRange"])?;
    if int_value(&model.member("Length")?)? > 0 {
        model = model.call_member("Characters", &[i4(1), i4(1)])?;
    }
    for property in ["Name", "NameFarEast", "Size", "Bold", "Italic", "Underline"] {
        attempt(|| {
            let target = range.member("Font")?;
            let value = model.member("Font")?.member(property)?;
            target.set_member(property, value)
        });
    }
    attempt(|| {
        if int_value(&walk(&model, &["Font", "Color", "Type"])?)? == 2 {
            let target = walk(range, &["Font", "Color"])?;
            let theme = walk(&model, &["Font", "Color", "ObjectThemeColor"])?;
            target.set_member("ObjectThemeColor", theme)
        } else {
            let target = walk(range, &["Font", "Color"])?;
            let rgb = walk(&model, &["Font", "Color", "RGB"])?;
            target.set_member("RGB", rgb)
        }
    });
    attempt(|| {
        let target = range.member("ParagraphFormat")?;
        let alignment = model.member("ParagraphFormat")?.member("Alignment")?;
        target.set_member("Alignment", alignment)
    });
    Ok(())
}

/// `set_table_cell_style`.
pub(crate) fn set_table_cell_style(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    if !truth(&shape.member("HasTable")?) {
        return Err(Error::host(format!("PowerPoint shape {} is not a table", text_of(&prop(op, "shape")))));
    }
    let rows = int_value(&walk(&shape, &["Table", "Rows", "Count"])?)?;
    let columns = int_value(&walk(&shape, &["Table", "Columns", "Count"])?)?;
    let row = int(&prop(op, "row"))?;
    let column = int(&prop(op, "col"))?;
    if row < 1 || row > rows || column < 1 || column > columns {
        return Err(Error::host(format!(
            "PPTX table shape {} is {rows}x{columns}; row {}, col {} is outside it",
            text_of(&prop(op, "shape")),
            text_of(&prop(op, "row")),
            text_of(&prop(op, "col"))
        )));
    }
    let cell = cell_shape(&shape, row, column)?;
    let props = prop(op, "properties");
    let fill_color = prop(&props, "fillColor");
    if has_property(&props, "fillColor") && !present(&fill_color) {
        put_path(&cell, &["Fill", "Visible"], i4(0))?;
    } else if truthy(&fill_color) {
        put_path(&cell, &["Fill", "Visible"], i4(-1))?;
        cell.member("Fill")?.call_member("Solid", &[])?;
        put_path(&cell, &["Fill", "ForeColor", "RGB"], color(&fill_color)?)?;
    }
    let horizontal = prop(&props, "horizontalAlignment");
    if truthy(&horizontal) {
        put_path(&cell, &["TextFrame", "TextRange", "ParagraphFormat", "Alignment"], i4(paragraph_alignment(&horizontal)))?;
    }
    let vertical = prop(&props, "verticalAlignment");
    if truthy(&vertical) {
        put_path(&cell, &["TextFrame", "VerticalAnchor"], i4(vertical_anchor(&vertical)))?;
    }
    let font = walk(&cell, &["TextFrame", "TextRange", "Font"])?;
    let font_name = prop(&props, "fontName");
    if truthy(&font_name) {
        set_font_name(&font, &text_of(&font_name))?;
    }
    let font_size = prop(&props, "fontSize");
    if truthy(&font_size) {
        font.set_member("Size", r4(single(&font_size)?))?;
    }
    let bold = prop(&props, "bold");
    if present(&bold) {
        font.set_member("Bold", office_flag(truthy(&bold)))?;
    }
    let italic = prop(&props, "italic");
    if present(&italic) {
        font.set_member("Italic", office_flag(truthy(&italic)))?;
    }
    let ink = prop(&props, "color");
    if truthy(&ink) {
        walk(&font, &["Color"])?.set_member("RGB", color(&ink)?)?;
    }
    Ok(record(vec![
        ("op", Value::string("set_table_cell_style")),
        ("changed", Value::Bool(true)),
        ("slide", Value::Int(slide_index(&slide)?)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("row", Value::Int(row)),
        ("col", Value::Int(column)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ps::payload::parse_payload;

    fn values(text: &str) -> Vec<Value> {
        array_of(&parse_payload(text).expect("values"))
    }

    #[test]
    fn a_column_of_figures_is_right_aligned_and_a_column_with_words_is_not() {
        let data = values("[[\"Name\",\"Revenue\",\"Note\"],[\"A\",\"1,200\",\"ok\"],[\"B\",\"-\",\"fine\"],[\"C\",\"35%\",\"\"]]");
        assert_eq!(right_columns(&data, 4, 3).unwrap(), vec![2]);
    }

    #[test]
    fn figures_carry_signs_currency_and_korean_units() {
        for figure in ["12", "+3.5", "$1,200", "(45)", "3.2배", "120억", "4개월", "\u{2212}7", "5 %", "-", "\u{2013}"] {
            assert!(!text::is_not_match(figure, FIGURE, false).unwrap(), "{figure}");
        }
        for word in ["abc", "12 apples", "", "1.2.y"] {
            assert!(text::is_not_match(word, FIGURE, false).unwrap(), "{word}");
        }
    }

    #[test]
    fn a_cell_past_the_data_is_empty_and_a_flat_row_is_read_as_powershell_indexes_it() {
        let data = values("[[\"a\",\"b\"],\"xyz\",5]");
        assert_eq!(cell_value(&data, 1, 2), Value::string("b"));
        assert_eq!(cell_value(&data, 1, 3), Value::string(""));
        assert_eq!(cell_value(&data, 2, 1), Value::string("x"));
        assert_eq!(cell_value(&data, 3, 1), Value::Int(5));
        assert_eq!(cell_value(&data, 4, 1), Value::string(""));
    }
}
