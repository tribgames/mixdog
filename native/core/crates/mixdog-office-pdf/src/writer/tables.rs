//! The table block of `pdf-writer.mjs` (`tableRows`, `tableLayout`, `drawTableRow`, `drawTableBlock`): natural column
//! widths, figure columns set right, cells wrapped inside their column with the row growing to the tallest cell, a bold
//! header on a rule, hairlines between the rows, a repeated header on every page, a caption that travels with the table
//! and no single orphan row or line at a page edge.

use std::cell::RefCell;
use std::sync::Arc;

use mixdog_js::math::max;
use mixdog_js::{to_number, value_to_string};
use mixdog_office_base::column_alignments::figure_column_alignments;
use mixdog_office_base::column_widths::natural_column_widths;
use mixdog_pdf::author::draw::parse_color;
use serde_json::Value;

use super::blocks::{block_type, items_of, num_nn, num_or, text_of, text_or, truthy};
use super::layout::{Flow, caption_height, wrap};
use super::{Face, RectStyle, WriterResult};

const PADDING: f64 = 4.0;

/// `tableRows(block)`: the headers (when given as a row) and the rows, every cell as text.
fn table_rows(block: &Value) -> Vec<Vec<String>> {
    let cells = |row: &Value| -> Vec<String> {
        match row {
            Value::Array(items) => items.iter().map(|value| text_of(Some(value))).collect(),
            other => vec![text_of(Some(other))],
        }
    };
    let mut rows = Vec::new();
    if let Some(Value::Array(headers)) = block.get("headers") {
        rows.push(headers.iter().map(|value| text_of(Some(value))).collect());
    }
    rows.extend(items_of(block.get("rows")).iter().map(cells));
    rows
}

struct LaidRow {
    cells: Vec<Vec<String>>,
    height: f64,
    face: Arc<Face>,
}

/// Cells wrap inside their column and the row grows to the tallest cell, so a long value never spills into its neighbour.
struct TableLayout {
    width: f64,
    cell_widths: Vec<f64>,
    font_size: f64,
    line_height: f64,
    inset: f64,
    header: bool,
    total: bool,
    /// The table anatomy the Word writer draws: a bold header on a rule, hairlines between the rows, no vertical rules;
    /// `grid: true` keeps the full cell grid for a form-like table.
    grid: bool,
    x0: f64,
    laid_out: Vec<LaidRow>,
    alignments: Vec<String>,
    leads: Vec<f64>,
    /// A header row a reader cannot tell from the data is not a header: without an explicit choice the row carries a
    /// neutral band and a rule under it.
    header_fill: Option<Value>,
    border_color: [f64; 3],
}

fn table_layout(flow: &Flow, block: &Value, rows: &[Vec<String>]) -> WriterResult<TableLayout> {
    // headers:false is a table with no header row (a totals block under the line items); otherwise the first row (the
    // headers, or rows[0] when none are given) is the header.
    let header = block.get("headers") != Some(&Value::Bool(false));
    let total = block.get("totalRow") == Some(&Value::Bool(true)) && rows.len() > usize::from(header);
    let last = rows.len().saturating_sub(1);
    let face_of =
        |row_index: usize| -> Arc<Face> { if (header && row_index == 0) || (total && row_index == last) { flow.bold.clone() } else { flow.font.clone() } };
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0).max(1);
    let width = num_or(block.get("width"), flow.page_width() - flow.margin * 2.0);
    let font_size = num_or(block.get("fontSize"), 9.0);
    let line_height = font_size * 1.3;
    // Words after figures start a padding further in: the figures end on their column's right edge, and "30분" and
    // "점검 필요" beside it read as one cell.
    let alignments = figure_column_alignments(rows, columns, items_of(block.get("columnAlignments")), header);
    let leads: Vec<f64> = alignments
        .iter()
        .enumerate()
        .map(|(column, alignment)| if column > 0 && alignments[column - 1] == "right" && alignment != "right" { PADDING } else { 0.0 })
        .collect();
    // Undeclared widths follow the text, the Word writer's rule (naturalColumnWidths).
    let failure = RefCell::new(None);
    let measure = |text: &str, row_index: usize, column: usize| -> f64 {
        match face_of(row_index).width(text, font_size) {
            Ok(wide) => wide + PADDING * 2.0 + leads[column],
            Err(error) => {
                failure.borrow_mut().get_or_insert(error);
                0.0
            }
        }
    };
    let declared = block.get("columnWidths");
    let weights: Vec<f64> = match declared {
        Some(Value::Array(items)) if items.len() == columns => items
            .iter()
            .map(|value| {
                let weight = to_number(value);
                max(0.0, if weight.is_nan() { 0.0 } else { weight })
            })
            .collect(),
        _ => natural_column_widths(rows, measure, width).unwrap_or_else(|| vec![1.0; columns]),
    };
    if let Some(error) = failure.into_inner() {
        return Err(error.into());
    }
    let weight_sum: f64 = weights.iter().sum();
    let total_weight = if weight_sum == 0.0 { columns as f64 } else { weight_sum };
    let cell_widths: Vec<f64> = weights.iter().map(|weight| width * (weight / total_weight)).collect();
    let min_row_height = num_or(block.get("rowHeight"), 24.0);
    // The space over a row's first line and under its last: a one-line row's text centred in the row, and every row
    // after it keeps the same inset, so a wrapped row grows by its lines and nothing else.
    let inset = max(PADDING, (min_row_height - line_height) / 2.0);
    let mut laid_out = Vec::with_capacity(rows.len());
    for (row_index, row) in rows.iter().enumerate() {
        let face = face_of(row_index);
        let mut cells = Vec::with_capacity(columns);
        for column in 0..columns {
            let text = row.get(column).map_or("", String::as_str);
            cells.push(wrap(&face, text, font_size, max(4.0, cell_widths[column] - PADDING * 2.0 - leads[column]))?);
        }
        let tallest = cells.iter().map(Vec::len).max().unwrap_or(0) as f64;
        let height = max(min_row_height, tallest * line_height + inset * 2.0);
        laid_out.push(LaidRow { cells, height, face });
    }
    let header_fill = match block.get("headerFill") {
        None => Some(Value::String(if flow.custom_palette { flow.ink.field.clone() } else { "EEF0F2".to_owned() })),
        Some(fill) => Some(fill.clone()),
    };
    Ok(TableLayout {
        width,
        cell_widths,
        font_size,
        line_height,
        inset,
        header,
        total,
        grid: block.get("grid") == Some(&Value::Bool(true)),
        x0: num_nn(block.get("x"), flow.margin),
        laid_out,
        alignments,
        leads,
        header_fill,
        border_color: parse_color(&text_or(block.get("borderColor"), &flow.ink.line))?,
    })
}

fn draw_table_row(flow: &mut Flow, block: &Value, layout: &TableLayout, row_index: usize) -> WriterResult<()> {
    let LaidRow { cells, height, face } = &layout.laid_out[row_index];
    let height = *height;
    let is_header = layout.header && row_index == 0;
    let is_total = layout.total && row_index == layout.laid_out.len() - 1;
    let top = flow.y;
    let mut x = layout.x0;
    for (column, lines) in cells.iter().enumerate() {
        let fill: Option<&Value> = if is_header {
            layout.header_fill.as_ref()
        } else if row_index % 2 == 0 {
            block.get("zebraFill")
        } else {
            None
        };
        let fill = fill.filter(|value| truthy(value));
        if layout.grid || fill.is_some() {
            let color = match fill {
                Some(fill) => Some(parse_color(&value_to_string(fill))?),
                None => None,
            };
            flow.page().draw_rectangle(&RectStyle {
                x,
                y: top - height,
                width: layout.cell_widths[column],
                height,
                color,
                border_color: layout.grid.then_some(layout.border_color),
                border_width: if layout.grid { 0.5 } else { 0.0 },
                ..RectStyle::default()
            });
        }
        // The Word writer's anatomy: a body row reads from its first line (every cell starts it at the same height,
        // where a one-line cell centred beside a wrapped one had floated between its two lines) and the header sits on
        // its rule.
        let text_top = if is_header { top - (height - layout.inset - lines.len() as f64 * layout.line_height) } else { top - layout.inset };
        let right = layout.alignments[column] == "right";
        let tint = if is_header && truthy(block.get("headerColor").unwrap_or(&Value::Null)) {
            text_or(block.get("headerColor"), "")
        } else {
            text_or(block.get("color"), "")
        };
        let tint = parse_color(&tint)?;
        for (line_index, line) in lines.iter().enumerate() {
            let text_left = if right { layout.cell_widths[column] - PADDING - face.width(line, layout.font_size)? } else { PADDING + layout.leads[column] };
            let line_y = text_top - line_index as f64 * layout.line_height - layout.font_size * 0.78 - (layout.line_height - layout.font_size) / 2.0;
            flow.page().draw_text(line, x + max(PADDING * 0.5, text_left), line_y, layout.font_size, face, tint)?;
        }
        x += layout.cell_widths[column];
    }
    let (x0, width, border) = (layout.x0, layout.width, layout.border_color);
    let rule = |flow: &mut Flow, y: f64, thickness: f64| flow.page().draw_line([x0, y], [x0 + width, y], thickness, border);
    // The total closes the column it sums: a stronger rule over it, in its bold face.
    if is_total {
        rule(flow, top, 1.1);
    }
    if is_header {
        rule(flow, top - height, 1.1);
    } else if !layout.grid {
        rule(flow, top - height, 0.5);
    }
    flow.y = top - height;
    Ok(())
}

/// The last row a page break may not separate from the one at `index`, the Word writer's rule: the header travels with
/// the first two rows and the last two rows travel together, and a table of six rows or fewer moves whole.
fn table_keep_through(count: usize, index: usize) -> usize {
    if count <= 6 {
        return if index == 0 { count - 1 } else { index };
    }
    if index == 0 {
        return 2;
    }
    if index == count - 2 { count - 1 } else { index }
}

fn unit_height(layout: &TableLayout, from: usize, through: usize) -> f64 {
    let end = (through + 1).min(layout.laid_out.len());
    let start = from.min(end);
    layout.laid_out[start..end].iter().fold(0.0, |sum, row| sum + row.height)
}

/// The room the first unit of a table takes, which the heading that opens it keeps beside itself.
pub fn table_lead_height(flow: &Flow, block: &Value) -> WriterResult<f64> {
    if block_type(block) != "table" {
        return Ok(0.0);
    }
    let rows = table_rows(block);
    if rows.is_empty() {
        return Ok(0.0);
    }
    let layout = table_layout(flow, block, &rows)?;
    Ok(unit_height(&layout, 0, table_keep_through(rows.len(), 0)))
}

pub fn draw_table_block(flow: &mut Flow, block: &Value, following: Option<&Value>) -> WriterResult<()> {
    let rows = table_rows(block);
    if rows.is_empty() {
        return Ok(());
    }
    let layout = table_layout(flow, block, &rows)?;
    let trailing = caption_height(following, &flow.font, layout.width)?;
    let last = layout.laid_out.len() - 1;
    for row_index in 0..=last {
        let through = table_keep_through(last + 1, row_index);
        let needed = unit_height(&layout, row_index, through) + if through == last { trailing } else { 0.0 };
        if flow.y - needed < flow.margin && !flow.at_top() {
            flow.new_page()?;
            if row_index > 0 && layout.header && block.get("repeatHeader") != Some(&Value::Bool(false)) {
                draw_table_row(flow, block, &layout, 0)?;
            }
        }
        draw_table_row(flow, block, &layout, row_index)?;
    }
    flow.y -= num_nn(block.get("after"), 12.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_header_travels_with_two_rows_and_the_last_two_rows_travel_together() {
        assert_eq!(table_keep_through(6, 0), 5);
        assert_eq!(table_keep_through(6, 3), 3);
        assert_eq!(table_keep_through(24, 0), 2);
        assert_eq!(table_keep_through(24, 22), 23);
        assert_eq!(table_keep_through(24, 10), 10);
    }

    #[test]
    fn rows_are_the_headers_then_the_rows_as_text() {
        let block = json!({ "headers": ["Item", "Cost"], "rows": [["a", 1], "b", [null, 2.5]] });
        assert_eq!(table_rows(&block), vec![vec!["Item", "Cost"], vec!["a", "1"], vec!["b"], vec!["", "2.5"]]);
        assert_eq!(table_rows(&json!({ "headers": false, "rows": [["x"]] })), vec![vec!["x"]]);
        assert!(table_rows(&json!({ "rows": [] })).is_empty());
    }
}
