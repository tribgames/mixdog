//! `portable/pptx-table-fit.mjs`: how a table row draws. PowerPoint grows a row to the tallest single-row text cell in it,
//! so a table's drawn height is its rows' declared heights raised to what their text needs, measured in the cell's own
//! margins.

use mixdog_fonts::face::FontError;
use mixdog_fsio::ReadProof;
use mixdog_js::{js_trim, math, string_to_number};

use crate::slide_shapes::EMU_PER_POINT;
use crate::text_metrics::{BlockMetrics, BlockOptions, Paragraph, TextMeasurer};
use crate::xml::{compiled, paragraph_texts};

/// PowerPoint's cell insets when a cell names none, in EMU.
const DEFAULT_LEFT_RIGHT: f64 = 91_440.0;
const DEFAULT_TOP_BOTTOM: f64 = 45_720.0;

/// The margins of a cell in EMU.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CellInsets {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

/// The height a cell's text needs against the room its row gives it.
#[derive(Debug, Clone, PartialEq)]
pub struct CellFit {
    pub measured: BlockMetrics,
    pub row_span: f64,
    /// The room in points: the rows the cell spans, less its margins.
    pub available: f64,
    pub insets: CellInsets,
}

/// A text cell of a row.
#[derive(Debug, Clone, PartialEq)]
pub struct TableCell {
    pub xml: String,
    pub body: String,
    pub size: f64,
    pub bold: bool,
    /// The 1-based position of the `a:tc` in its row (empty cells count).
    pub column_ordinal: usize,
    pub fit: Option<CellFit>,
}

/// A row's text cells and its drawn height in EMU.
#[derive(Debug, Clone, PartialEq)]
pub struct TableRow {
    pub cells: Vec<TableCell>,
    pub height: f64,
}

/// `Number(pattern.exec(text)?.[1])`: NaN when the pattern does not match.
fn captured_number(pattern: &str, text: &str) -> f64 {
    compiled(pattern, "").captures(text).and_then(|found| found.get(1).map(string_to_number)).unwrap_or(f64::NAN)
}

/// The insets a cell states on its tcPr (marL/marR/marT/marB), each side PowerPoint's default where unstated: a table
/// written with tight margins was measured inside the default ones and reported rows it did not overflow.
fn cell_insets(cell_xml: &str) -> CellInsets {
    let properties = compiled(r"<a:tcPr\b([^>]*)", "").captures(cell_xml).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
    let side = |name: &str, fallback: f64| -> f64 {
        let stated = compiled(&format!(r#"\b{name}="(\d+)""#), "").captures(&properties).and_then(|found| found.get(1).map(string_to_number));
        stated.unwrap_or(fallback)
    };
    CellInsets {
        left: side("marL", DEFAULT_LEFT_RIGHT),
        right: side("marR", DEFAULT_LEFT_RIGHT),
        top: side("marT", DEFAULT_TOP_BOTTOM),
        bottom: side("marB", DEFAULT_TOP_BOTTOM),
    }
}

/// `Number(x) || fallback`.
fn or_default(value: f64, fallback: f64) -> f64 {
    if value.is_nan() || value == 0.0 { fallback } else { value }
}

/// The height a cell's text needs against the room its row gives it, or `None` when the row or column carries no size. A
/// merged label cell (rowSpan) owns the rows it spans: its room is theirs together, not one row's.
fn table_cell_fit<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    cell_xml: &str,
    paragraph: Paragraph,
    widths: &[f64],
    column_ordinal: usize,
    declared: f64,
) -> Result<Option<CellFit>, FontError> {
    let width = widths.get(column_ordinal - 1).copied().unwrap_or(0.0);
    if declared == 0.0 || width == 0.0 || width.is_nan() {
        return Ok(None);
    }
    let row_span = math::max(1.0, or_default(captured_number(r#"<a:tc\b[^>]*\browSpan="(\d+)""#, cell_xml), 1.0));
    let grid_span = math::max(1.0, or_default(captured_number(r#"<a:tc\b[^>]*\bgridSpan="(\d+)""#, cell_xml), 1.0));
    let from = column_ordinal - 1;
    let to = (from as f64 + grid_span).min(widths.len() as f64) as usize;
    let spanned: f64 = widths.get(from..to).unwrap_or(&[]).iter().fold(0.0, |sum, value| sum + value);
    let spanned_width = if spanned == 0.0 { width } else { spanned };
    let insets = cell_insets(cell_xml);
    let usable = (spanned_width - insets.left - insets.right) / EMU_PER_POINT;
    let available = (declared * row_span - insets.top - insets.bottom) / EMU_PER_POINT;
    if usable <= 0.0 || available <= 0.0 || usable.is_nan() || available.is_nan() {
        return Ok(None);
    }
    let measured = measurer.measure_text_block(&[paragraph], &BlockOptions { width: usable, ..BlockOptions::default() })?;
    Ok(Some(CellFit { measured, row_span, available, insets }))
}

/// `tableRowCells(rowXml, widths)`: a table row's text cells, each with its fit against the row's declared height, and the
/// row's drawn height in EMU: PowerPoint grows a row to its tallest single-row cell.
pub fn table_row_cells<P: ReadProof>(measurer: &TextMeasurer<'_, P>, row_xml: &str, widths: &[f64]) -> Result<TableRow, FontError> {
    let declared = or_default(captured_number(r#"<a:tr\b[^>]*\bh="(\d+)""#, row_xml), 0.0);
    let mut height = declared;
    let mut cells = Vec::new();
    let mut column_ordinal = 0;
    for found in compiled(r"<a:tc(?:\s[^>]*)?>[\s\S]*?</a:tc>", "g").find_iter(row_xml) {
        let cell = &row_xml[found];
        column_ordinal += 1;
        let body = compiled(r"<a:txBody>[\s\S]*?</a:txBody>", "").find(cell).map_or("", |range| &cell[range]);
        let text = js_trim(&paragraph_texts(body, "a:t").join(" ")).to_owned();
        if text.is_empty() {
            continue;
        }
        let size = or_default(captured_number(r#"<a:rPr\b[^>]*\bsz="(\d+)""#, body) / 100.0, 18.0);
        let bold = compiled(r#"<a:rPr\b[^>]*\bb="1""#, "").is_match(body);
        let paragraph = Paragraph { text, font_size: Some(size), bold, ..Paragraph::default() };
        let fit = table_cell_fit(measurer, cell, paragraph, widths, column_ordinal, declared)?;
        if let Some(fit) = fit.as_ref().filter(|fit| fit.row_span == 1.0) {
            height = math::max(height, fit.measured.height * EMU_PER_POINT + fit.insets.top + fit.insets.bottom);
        }
        cells.push(TableCell { xml: cell.to_owned(), body: body.to_owned(), size, bold, column_ordinal, fit });
    }
    Ok(TableRow { cells, height })
}

/// `tableDrawnHeight(tableXml)`: the height a table draws to, in EMU: every row at the larger of its declared height and its
/// tallest cell. A frame declared at 150 pt around ten 18 pt rows draws to twice that, over the source line under it.
pub fn table_drawn_height<P: ReadProof>(measurer: &TextMeasurer<'_, P>, table_xml: &str) -> Result<f64, FontError> {
    let widths: Vec<f64> =
        compiled(r#"<a:gridCol\b[^>]*\bw="(\d+)""#, "g").captures_iter(table_xml).map(|found| string_to_number(found.get(1).unwrap_or(""))).collect();
    if widths.is_empty() {
        return Ok(0.0);
    }
    let mut total = 0.0;
    for row in compiled(r"<a:tr\b[^>]*>[\s\S]*?</a:tr>", "g").find_iter(table_xml) {
        total += table_row_cells(measurer, &table_xml[row], &widths)?.height;
    }
    Ok(total)
}
