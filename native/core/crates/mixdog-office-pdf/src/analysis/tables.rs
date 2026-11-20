//! `inferPdfTables`: the tables of a layout. A bordered table is its cell rectangles (ruled); an unruled one is read
//! from how its text runs line up in columns (alignment). Prose is ignored.

use mixdog_js::{js_sort_by, js_trim};
use serde_json::Value;

use super::layout::{BoxShape, LayoutItem, PageLayout, PdfLayout};
use super::{collapse_spaces, js_max, json_number, object, round_to, round2};

/// A PDF reports the runs it drew, not cells: a cell whose words were drawn as separate runs would count as several
/// columns and break its row against the rows around it. Runs closer than half a line height are the same cell: the
/// gap a column boundary leaves is several times that.
const INTRA_CELL_GAP_RATIO: f64 = 0.5;

const TABLE_SNAP_TOLERANCE: f64 = 2.0;

/// How far apart two rows of an unruled table may sit and still belong to it, in multiples of the row's own line
/// height: a table steps by about a line, and a page's separate blocks sit further apart than that.
const ALIGNMENT_ROW_GAP: f64 = 2.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableSource {
    Ruled,
    Alignment,
}

impl TableSource {
    pub fn as_str(self) -> &'static str {
        match self {
            TableSource::Ruled => "ruled",
            TableSource::Alignment => "alignment",
        }
    }
}

/// A cell that spans columns: where it starts and how many it covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Merge {
    pub row: usize,
    pub column: usize,
    pub span: usize,
}

/// One cell of a row's geometry; `text` is kept for the rows of an unruled table.
#[derive(Debug, Clone, PartialEq)]
pub struct GeometryCell {
    pub text: Option<String>,
    pub x: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeometryRow {
    pub top: f64,
    pub cells: Vec<GeometryCell>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PdfTable {
    pub page: usize,
    pub columns: usize,
    pub confidence: f64,
    pub source: TableSource,
    /// A shaded first row over unshaded body rows is the header the document drew.
    pub header: bool,
    pub merges: Vec<Merge>,
    pub rows: Vec<Vec<String>>,
    pub geometry: Vec<GeometryRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableSet {
    pub page_count: i64,
    pub tables: Vec<PdfTable>,
    pub truncated: bool,
}

/// `a || b` of two comparator terms: the second decides when the first is zero or NaN.
fn then_by(first: f64, second: impl FnOnce() -> f64) -> f64 {
    if first != 0.0 && !first.is_nan() { first } else { second() }
}

// ---- unruled: rows of runs -----------------------------------------------------------------------------------------

struct Cell {
    text: String,
    x: f64,
    width: f64,
    height: f64,
}

struct Row {
    top: f64,
    cells: Vec<Cell>,
}

fn merge_row_runs(items: &[&LayoutItem]) -> Vec<Cell> {
    let mut cells: Vec<Cell> = Vec::new();
    for item in items {
        let gap = cells.last().map_or(f64::INFINITY, |last| item.x - (last.x + last.width));
        if let Some(last) = cells.last_mut()
            && gap <= INTRA_CELL_GAP_RATIO * js_max(last.height, item.height)
        {
            if gap > 0.5 {
                last.text.push(' ');
            }
            last.text.push_str(&item.text);
            last.width = item.x + item.width - last.x;
            last.height = js_max(last.height, item.height);
            continue;
        }
        cells.push(Cell { text: item.text.clone(), x: item.x, width: item.width, height: item.height });
    }
    cells
}

fn cluster_rows(items: &[LayoutItem], tolerance: f64) -> Vec<Row> {
    let mut sorted: Vec<&LayoutItem> = items.iter().collect();
    js_sort_by(&mut sorted, |left, right| then_by(left.top - right.top, || left.x - right.x));
    let mut rows: Vec<(f64, Vec<&LayoutItem>)> = Vec::new();
    for item in sorted {
        if js_trim(&item.text).is_empty() {
            continue;
        }
        let at = match rows.iter().position(|entry| (entry.0 - item.top).abs() <= tolerance) {
            Some(at) => at,
            None => {
                rows.push((item.top, Vec::new()));
                rows.len() - 1
            }
        };
        let row = &mut rows[at];
        row.1.push(item);
        let count = row.1.len() as f64;
        row.0 = (row.0 * (count - 1.0) + item.top) / count;
    }
    rows.into_iter()
        .map(|(top, mut cells)| {
            js_sort_by(&mut cells, |left, right| left.x - right.x);
            Row {
                top: round2(top),
                cells: merge_row_runs(&cells).into_iter().map(|cell| Cell { text: js_trim(&collapse_spaces(&cell.text)).to_owned(), ..cell }).collect(),
            }
        })
        .collect()
}

/// Tables of an unruled page, read from how its text runs line up in columns.
fn aligned_tables(page: &PageLayout) -> Vec<PdfTable> {
    let rows: Vec<Row> = cluster_rows(&page.items, 3.0).into_iter().filter(|row| row.cells.len() >= 2).collect();
    if rows.len() < 2 {
        return Vec::new();
    }
    // Rows far apart on the page are not a table. A form's field labels and the footer under them line up in two
    // columns, and taken together by position alone they came back as a two-row table of a label and a page number. A
    // table's rows follow each other by about a line, so the block ends where that stops being true.
    let mut blocks: Vec<(Vec<Row>, f64)> = Vec::new();
    for row in rows {
        let height = row.cells.iter().fold(1.0, |height, cell| js_max(height, if cell.height.is_nan() { 0.0 } else { cell.height }));
        let bottom = row.top + height;
        let joins = blocks.last().is_some_and(|current| row.top - current.1 <= height * ALIGNMENT_ROW_GAP);
        if joins && let Some(current) = blocks.last_mut() {
            current.0.push(row);
            current.1 = bottom;
        } else {
            blocks.push((vec![row], bottom));
        }
    }
    let mut tables = Vec::new();
    for (block, _) in blocks {
        if block.len() < 2 {
            continue;
        }
        let mut counts: Vec<(usize, usize)> = Vec::new();
        for row in &block {
            match counts.iter_mut().find(|entry| entry.0 == row.cells.len()) {
                Some(entry) => entry.1 += 1,
                None => counts.push((row.cells.len(), 1)),
            }
        }
        // The most common row width; the first met wins a tie (the sort is stable).
        let (columns, repeated) = counts.iter().fold((0, 0), |best, entry| if entry.1 > best.1 { *entry } else { best });
        let total = block.len();
        let selected: Vec<&Row> = block.iter().filter(|row| row.cells.len().abs_diff(columns) <= 1).collect();
        if columns < 2 || selected.len() < 2 {
            continue;
        }
        tables.push(PdfTable {
            page: page.page,
            columns,
            confidence: round_to(repeated as f64 / total as f64, 3),
            source: TableSource::Alignment,
            header: false,
            merges: Vec::new(),
            rows: selected.iter().map(|row| row.cells.iter().map(|cell| cell.text.clone()).collect()).collect(),
            geometry: selected
                .iter()
                .map(|row| GeometryRow {
                    top: row.top,
                    cells: row
                        .cells
                        .iter()
                        .map(|cell| GeometryCell { text: Some(cell.text.clone()), x: cell.x, width: cell.width, height: cell.height })
                        .collect(),
                })
                .collect(),
        });
    }
    tables
}

// ---- ruled: rows of cell rectangles --------------------------------------------------------------------------------

/// Text inside one cell, line by line; adjacent runs on a line are joined without a space unless the PDF left a gap
/// between them.
fn text_in_box(items: &[LayoutItem], cell: &BoxShape) -> String {
    let mut inside: Vec<&LayoutItem> = items
        .iter()
        .filter(|item| {
            let center_x = item.x + item.width / 2.0;
            let center_y = item.top + item.height / 2.0;
            center_x >= cell.x && center_x <= cell.x + cell.width && center_y >= cell.top && center_y <= cell.top + cell.height
        })
        .collect();
    js_sort_by(&mut inside, |left, right| then_by(left.top - right.top, || left.x - right.x));
    struct Line {
        top: f64,
        text: String,
        end: Option<f64>,
    }
    let mut lines: Vec<Line> = Vec::new();
    for item in inside {
        let at = match lines.iter().position(|entry| (entry.top - item.top).abs() <= 2.0) {
            Some(at) => at,
            None => {
                lines.push(Line { top: item.top, text: String::new(), end: None });
                lines.len() - 1
            }
        };
        let line = &mut lines[at];
        let gap = line.end.map_or(0.0, |end| item.x - end);
        if !line.text.is_empty() && gap > 1.0 && !line.text.ends_with(' ') && !item.text.starts_with(' ') {
            line.text.push(' ');
        }
        line.text.push_str(&item.text);
        line.end = Some(item.x + item.width);
    }
    lines.iter().map(|line| js_trim(&collapse_spaces(&line.text)).to_owned()).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n")
}

/// The same column edge drawn on two rows can differ by a fraction of a point, and comparing raw coordinates splits
/// one table into several. Near-identical positions collapse to the average of their cluster.
fn snap_positions(values: &[f64]) -> Vec<f64> {
    let mut sorted = values.to_vec();
    js_sort_by(&mut sorted, |left, right| left - right);
    let mut clusters: Vec<Vec<f64>> = Vec::new();
    for value in sorted {
        let joins = clusters.last().is_some_and(|last| value - last[last.len() - 1] <= TABLE_SNAP_TOLERANCE);
        if joins && let Some(last) = clusters.last_mut() {
            last.push(value);
        } else {
            clusters.push(vec![value]);
        }
    }
    clusters.iter().map(|cluster| cluster.iter().fold(0.0, |total, value| total + value) / cluster.len() as f64).collect()
}

/// The index of the edge `value` sits on, or `None` when it sits on none of them.
fn snap_to(edges: &[f64], value: f64) -> Option<usize> {
    let mut best = None;
    let mut distance = f64::INFINITY;
    for (index, edge) in edges.iter().enumerate() {
        let gap = (edge - value).abs();
        if gap < distance {
            distance = gap;
            best = Some(index);
        }
    }
    if distance <= TABLE_SNAP_TOLERANCE { best } else { None }
}

/// A row belongs to the table when its edges sit on the table's grid (a merged cell simply omits the edges it spans)
/// or when the grid sits on the row's edges (the row is finer, so the grid grows instead of a second table starting).
/// Anything else is a different table.
fn fits_grid(grid: &[f64], starts: &[f64]) -> bool {
    starts.iter().all(|value| snap_to(grid, *value).is_some()) || grid.iter().all(|value| snap_to(starts, *value).is_some())
}

struct RuledRow<'a> {
    top: f64,
    cells: Vec<&'a BoxShape>,
}

struct Draft<'a> {
    grid: Vec<f64>,
    rows: Vec<RuledRow<'a>>,
    bottom: f64,
}

fn ruled_table(page: &PageLayout, draft: &Draft<'_>) -> PdfTable {
    let grid = &draft.grid;
    let columns = grid.len();
    let mut merges = Vec::new();
    let mut rows = Vec::new();
    for (row_index, row) in draft.rows.iter().enumerate() {
        let mut values = vec![String::new(); columns];
        for cell in &row.cells {
            let Some(start) = snap_to(grid, cell.x) else {
                continue;
            };
            let end = snap_to(grid, cell.x + cell.width);
            // A cell ending past the last edge closes the row, so it spans the rest.
            let span = end.unwrap_or(columns).saturating_sub(start).max(1);
            values[start] = text_in_box(&page.items, cell);
            if span > 1 {
                merges.push(Merge { row: row_index, column: start, span });
            }
        }
        rows.push(values);
    }
    // A shaded first row over unshaded body rows is the header the document drew.
    let header = draft.rows[0].cells.iter().all(|cell| cell.filled) && draft.rows.iter().skip(1).any(|row| row.cells.iter().any(|cell| !cell.filled));
    PdfTable {
        page: page.page,
        columns,
        confidence: 1.0,
        source: TableSource::Ruled,
        header,
        merges,
        rows,
        geometry: draft
            .rows
            .iter()
            .map(|row| GeometryRow {
                top: row.top,
                cells: row.cells.iter().map(|cell| GeometryCell { text: None, x: cell.x, width: cell.width, height: cell.height }).collect(),
            })
            .collect(),
    }
}

/// A bordered table is its cell rectangles: rows are boxes sharing a top edge, and consecutive rows sharing a column
/// grid form one table. Text is assigned by containment, so wrapped cells and blank cells come out right, and a row
/// stays as wide as the grid even where cells are merged.
fn ruled_tables(page: &PageLayout) -> Vec<PdfTable> {
    let mut cells: Vec<&BoxShape> = page
        .boxes
        .iter()
        .filter(|shape| !shape.checkbox && shape.width >= 8.0 && shape.height >= 6.0 && shape.width < page.width * 0.98 && shape.height < page.height * 0.5)
        .collect();
    if cells.len() < 4 {
        return Vec::new();
    }
    js_sort_by(&mut cells, |left, right| then_by(left.top - right.top, || left.x - right.x));
    let mut rows: Vec<RuledRow<'_>> = Vec::new();
    for cell in cells {
        let at = match rows.iter().position(|entry| (entry.top - cell.top).abs() <= TABLE_SNAP_TOLERANCE) {
            Some(at) => at,
            None => {
                rows.push(RuledRow { top: cell.top, cells: Vec::new() });
                rows.len() - 1
            }
        };
        if !rows[at].cells.iter().any(|existing| (existing.x - cell.x).abs() <= 1.0) {
            rows[at].cells.push(cell);
        }
    }
    let mut drafts: Vec<Draft<'_>> = Vec::new();
    for mut row in rows {
        js_sort_by(&mut row.cells, |left, right| left.x - right.x);
        let starts: Vec<f64> = row.cells.iter().map(|cell| cell.x).collect();
        let bottom = row.top + row.cells.iter().fold(f64::NEG_INFINITY, |height, cell| js_max(height, cell.height));
        let joins = drafts.last().is_some_and(|current| (current.bottom - row.top).abs() <= TABLE_SNAP_TOLERANCE && fits_grid(&current.grid, &starts));
        if joins && let Some(current) = drafts.last_mut() {
            let mut edges = current.grid.clone();
            edges.extend(&starts);
            current.grid = snap_positions(&edges);
            current.rows.push(row);
            current.bottom = bottom;
        } else {
            drafts.push(Draft { grid: snap_positions(&starts), rows: vec![row], bottom });
        }
    }
    drafts.iter().filter(|draft| draft.rows.len() >= 2 && draft.grid.len() >= 2).map(|draft| ruled_table(page, draft)).collect()
}

/// `inferPdfTables(layout)`: a page with ruled tables reports those; otherwise the tables its text lines up in.
pub fn infer_pdf_tables(layout: &PdfLayout) -> TableSet {
    let mut tables = Vec::new();
    for page in &layout.pages {
        let ruled = ruled_tables(page);
        if !ruled.is_empty() {
            tables.extend(ruled);
            continue;
        }
        tables.extend(aligned_tables(page));
    }
    TableSet { page_count: layout.page_count, tables, truncated: layout.truncated }
}

// ---- the JSON Node returns -------------------------------------------------------------------------------------------

impl PdfTable {
    pub fn to_json(&self) -> Value {
        let mut pairs = vec![
            ("page", Value::from(self.page)),
            ("columns", Value::from(self.columns)),
            ("confidence", json_number(self.confidence)),
            ("source", Value::from(self.source.as_str())),
        ];
        if self.header {
            pairs.push(("header", Value::Bool(true)));
        }
        if !self.merges.is_empty() {
            let merges = self
                .merges
                .iter()
                .map(|merge| object(vec![("row", Value::from(merge.row)), ("column", Value::from(merge.column)), ("span", Value::from(merge.span))]))
                .collect();
            pairs.push(("merges", Value::Array(merges)));
        }
        let rows = self.rows.iter().map(|row| Value::Array(row.iter().map(|cell| Value::from(cell.clone())).collect())).collect();
        pairs.push(("rows", Value::Array(rows)));
        let geometry = self
            .geometry
            .iter()
            .map(|row| {
                let cells = row
                    .cells
                    .iter()
                    .map(|cell| {
                        let mut parts = Vec::new();
                        if let Some(text) = &cell.text {
                            parts.push(("text", Value::from(text.clone())));
                        }
                        parts.push(("x", json_number(cell.x)));
                        parts.push(("width", json_number(cell.width)));
                        parts.push(("height", json_number(cell.height)));
                        object(parts)
                    })
                    .collect();
                object(vec![("top", json_number(row.top)), ("cells", Value::Array(cells))])
            })
            .collect();
        pairs.push(("geometry", Value::Array(geometry)));
        object(pairs)
    }
}

impl TableSet {
    pub fn to_json(&self) -> Value {
        object(vec![
            ("pageCount", Value::from(self.page_count)),
            ("tableCount", Value::from(self.tables.len())),
            ("tables", Value::Array(self.tables.iter().map(PdfTable::to_json).collect())),
            ("truncated", Value::Bool(self.truncated)),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(text: &str, x: f64, top: f64, width: f64) -> LayoutItem {
        LayoutItem { text: text.to_owned(), x, top, width, height: 10.0, vertical: false, reversed: false, direction: "ltr".to_owned(), font: String::new() }
    }

    fn shape(x: f64, top: f64, width: f64, height: f64, filled: bool) -> BoxShape {
        BoxShape { x, top, width, height, filled, stroked: true, checkbox: false }
    }

    fn page(items: Vec<LayoutItem>, boxes: Vec<BoxShape>) -> PageLayout {
        PageLayout {
            page: 1,
            width: 612.0,
            height: 792.0,
            origin: None,
            transform: [1.0, 0.0, 0.0, -1.0, 0.0, 792.0],
            items,
            lines: Vec::new(),
            boxes,
            shapes_unavailable: None,
            links: Vec::new(),
        }
    }

    fn layout(page: PageLayout) -> PdfLayout {
        PdfLayout { page_count: 1, pages: vec![page], truncated: false }
    }

    #[test]
    fn a_grid_of_boxes_is_a_ruled_table_with_the_text_in_its_cells() {
        let mut boxes = Vec::new();
        let mut items = Vec::new();
        for (row, top) in [100.0, 120.0, 140.0].into_iter().enumerate() {
            for (column, x) in [50.0, 150.0, 250.0].into_iter().enumerate() {
                boxes.push(shape(x, top, 100.0, 20.0, row == 0));
                items.push(item(&format!("r{row}c{column}"), x + 4.0, top + 5.0, 30.0));
            }
        }
        let tables = infer_pdf_tables(&layout(page(items, boxes)));
        assert_eq!(tables.tables.len(), 1);
        let table = &tables.tables[0];
        assert_eq!((table.columns, table.source, table.confidence), (3, TableSource::Ruled, 1.0));
        assert!(table.header);
        assert_eq!(table.rows[1], ["r1c0", "r1c1", "r1c2"]);
        assert!(table.merges.is_empty());
    }

    #[test]
    fn a_wide_cell_is_a_merge_and_leaves_its_neighbours_blank() {
        let mut boxes = Vec::new();
        for top in [100.0, 120.0] {
            for x in [50.0, 150.0, 250.0] {
                boxes.push(shape(x, top, 100.0, 20.0, false));
            }
        }
        boxes.push(shape(50.0, 140.0, 100.0, 20.0, false));
        boxes.push(shape(150.0, 140.0, 200.0, 20.0, false));
        let items = vec![item("left", 54.0, 145.0, 20.0), item("wide", 154.0, 145.0, 20.0)];
        let tables = infer_pdf_tables(&layout(page(items, boxes)));
        let table = &tables.tables[0];
        assert_eq!(table.merges, [Merge { row: 2, column: 1, span: 2 }]);
        assert_eq!(table.rows[2], ["left", "wide", ""]);
    }

    #[test]
    fn checkboxes_and_page_wide_boxes_are_not_cells() {
        let mut checkbox = shape(10.0, 10.0, 10.0, 10.0, false);
        checkbox.checkbox = true;
        let boxes = vec![checkbox, shape(0.0, 0.0, 612.0, 100.0, false), shape(10.0, 200.0, 100.0, 20.0, false)];
        assert!(infer_pdf_tables(&layout(page(Vec::new(), boxes))).tables.is_empty());
    }

    #[test]
    fn rows_of_aligned_runs_are_a_table_by_alignment() {
        let mut items = Vec::new();
        for (row, top) in [100.0, 112.0, 124.0, 136.0].into_iter().enumerate() {
            for (column, x) in [50.0, 200.0, 350.0].into_iter().enumerate() {
                items.push(item(&format!("v{row}{column}"), x, top, 40.0));
            }
        }
        let tables = infer_pdf_tables(&layout(page(items, Vec::new())));
        assert_eq!(tables.tables.len(), 1);
        let table = &tables.tables[0];
        assert_eq!((table.columns, table.source, table.confidence), (3, TableSource::Alignment, 1.0));
        assert_eq!(table.rows.len(), 4);
        assert_eq!(table.geometry[0].cells[1].text.as_deref(), Some("v01"));
    }

    #[test]
    fn runs_closer_than_half_a_line_are_one_cell_and_a_wide_gap_is_a_column() {
        let items = vec![
            item("Total", 50.0, 100.0, 30.0),
            item("amount", 83.0, 100.0, 40.0),
            item("12", 300.0, 100.0, 10.0),
            item("Net", 50.0, 112.0, 20.0),
            item("amount", 74.0, 112.0, 40.0),
            item("9", 300.0, 112.0, 10.0),
        ];
        let tables = infer_pdf_tables(&layout(page(items, Vec::new())));
        assert_eq!(tables.tables[0].rows, [["Total amount", "12"], ["Net amount", "9"]]);
    }

    #[test]
    fn rows_far_apart_are_not_one_table_and_prose_is_ignored() {
        let items = vec![
            item("Name", 50.0, 100.0, 30.0),
            item("Ann", 200.0, 100.0, 30.0),
            item("Page", 50.0, 700.0, 30.0),
            item("2", 200.0, 700.0, 10.0),
            item("A single line of prose with no columns at all", 50.0, 300.0, 300.0),
        ];
        assert!(infer_pdf_tables(&layout(page(items, Vec::new()))).tables.is_empty());
    }

    #[test]
    fn the_most_common_row_width_sets_the_columns_and_its_neighbours_stay() {
        let mut items = Vec::new();
        for (row, top) in [100.0, 112.0, 124.0].into_iter().enumerate() {
            items.push(item("a", 50.0, top, 10.0));
            items.push(item("b", 200.0, top, 10.0));
            if row == 1 {
                items.push(item("c", 350.0, top, 10.0));
            }
        }
        let table = &infer_pdf_tables(&layout(page(items, Vec::new()))).tables[0];
        assert_eq!(table.columns, 2);
        assert_eq!(table.rows.len(), 3);
        assert_eq!(table.confidence, 0.667);
    }

    #[test]
    fn the_json_carries_the_source_and_the_geometry_without_text_for_a_ruled_table() {
        let mut boxes = Vec::new();
        for top in [100.0, 120.0] {
            for x in [50.0, 150.0] {
                boxes.push(shape(x, top, 100.0, 20.0, false));
            }
        }
        let json = infer_pdf_tables(&layout(page(Vec::new(), boxes))).to_json();
        assert_eq!(json["tableCount"], 1);
        assert_eq!(json["tables"][0]["source"], "ruled");
        assert_eq!(json["tables"][0]["geometry"][0]["cells"][0], serde_json::json!({ "x": 50, "width": 100, "height": 20 }));
    }
}
