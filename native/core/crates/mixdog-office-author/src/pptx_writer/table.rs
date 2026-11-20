//! Tables: what `addTable` is given (`TableRow`, `TableCell`, `TableProps`), how pptxgenjs 4.0.1 prepares the options
//! (`addTableDefinition`: the position and size, the default margin, size and colour, the borders of every cell) and
//! the `p:graphicFrame` it writes (the table branch of `slideObjectToXml`: the column grid, the row heights, the
//! merged cells, the cell margins, anchors and borders), with every cell's text written by the text body writer.
//!
//! Not carried: auto-paging a long table over new slides (`autoPage`, which `pptx-html-build.mjs` does not use), and
//! a `hyperlink` option on the table itself (it is not an option of a table).

use super::shapes::{Fill, Hyperlink, color_element, color_selection};
use super::text::{BodyKind, BodyProperties, Border, Borders, Margin, Run, TextContent, TextOptions, Underline, text_body_xml};
use mixdog_js::math;

use super::{Axis, Dim, EMU, Layout, encode_xml_entities, inch_to_emu, is_set, num, or, round, smart_parse, val_to_pts};

const DEFAULT_BORDER_COLOR: &str = "666666";
const DEFAULT_FONT_COLOR: &str = "000000";
const DEFAULT_FONT_SIZE: f64 = 12.0;
const DEFAULT_CELL_MARGIN: [f64; 4] = [0.05, 0.1, 0.05, 0.1];
const DEFAULT_SLIDE_MARGIN: f64 = 0.5;

/// `colW`: one width for every column, or one for each.
#[derive(Debug, Clone, PartialEq)]
pub enum ColWidths {
    One(f64),
    Each(Vec<f64>),
}

/// `rowH`: one height for every row, or one for each.
#[derive(Debug, Clone, PartialEq)]
pub enum RowHeights {
    One(f64),
    Each(Vec<f64>),
}

/// A cell of a row: a string, or an object with text (a string or formatted runs) and its own options.
#[derive(Debug, Clone, PartialEq)]
pub enum TableCell {
    Plain(String),
    Cell { text: TextContent, options: Option<TextOptions> },
}

/// What `addTable` is given as options: the frame and the cell defaults are text options, the sizes of the columns
/// and rows are the table's own.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TableOptions {
    pub text: TextOptions,
    pub col_w: Option<ColWidths>,
    pub row_h: Option<RowHeights>,
    pub auto_page: bool,
}

/// Where a table goes: how many tables the slide has (the name of an unnamed one), its number among them, the
/// slide's number and the sheet it is on.
pub(crate) struct TablePlacement<'a> {
    pub tables_before: usize,
    pub slide_number: usize,
    pub layout: &'a Layout,
}

/// A table on a slide, written (`p:graphicFrame`) when it is added.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TableObject {
    xml: String,
}

impl TableObject {
    pub(crate) fn xml(&self) -> &str {
        &self.xml
    }

    /// `addTableDefinition` and the table branch of `slideObjectToXml`. `link` is given a hyperlink and returns the
    /// relationship id the slide stored it under.
    pub(crate) fn new(
        rows: Vec<Vec<TableCell>>,
        options: TableOptions,
        place: &TablePlacement<'_>,
        link: &mut dyn FnMut(&Hyperlink) -> usize,
    ) -> Result<Self, String> {
        if rows.is_empty() {
            return Err(
                "addTable: Array expected! EX: 'slide.addTable( [rows], {options} );' (https://gitbrent.github.io/PptxGenJS/docs/api-tables.html)".to_owned()
            );
        }
        if options.auto_page {
            return Err("auto-paged tables are not carried by the pptx writer".to_owned());
        }
        let layout = place.layout;
        let TableOptions { text: mut opt, col_w, row_h, .. } = options;
        let object_name = match opt.frame.object_name.as_deref() {
            Some(name) if !name.is_empty() => encode_xml_entities(name),
            _ => format!("Table {}", place.tables_before),
        };
        // STEP 2: the cells, each with its borders.
        let raw_border = opt.border.clone();
        let mut cells: Vec<Vec<Cell>> = rows.into_iter().map(|row| row.into_iter().map(|cell| Cell::from_input(cell, &raw_border)).collect()).collect();
        // STEP 3: the options of the table.
        let first_row_columns: usize = cells[0].iter().map(|cell| cell.options.colspan.filter(|span| *span > 0).unwrap_or(1)).sum();
        let (x, y) = (table_position(opt.frame.x, Axis::X, layout), table_position(opt.frame.y, Axis::Y, layout));
        let mut height = opt.frame.h;
        if height.is_some_and(Dim::truthy) {
            height = height.map(|dim| Dim::Number(smart_parse(dim, Axis::Y, layout)));
        }
        opt.font_size = Some(or(opt.font_size, DEFAULT_FONT_SIZE));
        opt.margin = Some(Margin::Each(match opt.margin.take() {
            Some(Margin::All(all)) => vec![all; 4],
            Some(Margin::Each(each)) => each,
            None => DEFAULT_CELL_MARGIN.to_vec(),
        }));
        if !mentions_hyperlink(&cells) && !opt.color.as_deref().is_some_and(|color| !color.is_empty()) {
            opt.color = Some(DEFAULT_FONT_COLOR.to_owned());
        }
        let mut width = opt.frame.w;
        let mut col_w = col_w;
        let has_col_w = match &col_w {
            Some(ColWidths::One(width)) => is_set(Some(*width)),
            Some(ColWidths::Each(_)) => true,
            None => false,
        };
        if has_col_w {
            let columns = first_row_columns as f64;
            // `Some(Some(w))`: the width is made from the column width and `colW` is dropped; `Some(None)`: `colW` is
            // dropped because it does not match the columns.
            let reset = match &col_w {
                Some(ColWidths::One(each)) => Some(Some(math::floor(*each * columns))),
                Some(ColWidths::Each(each)) if each.len() == 1 && first_row_columns > 1 => Some(Some(math::floor(each[0] * columns))),
                Some(ColWidths::Each(each)) if each.len() != first_row_columns => Some(None),
                _ => None,
            };
            if let Some(made) = reset {
                if let Some(made) = made {
                    width = Some(Dim::Number(made));
                }
                col_w = None;
            }
        } else if width.is_some_and(Dim::truthy) {
            width = width.map(|dim| Dim::Number(smart_parse(dim, Axis::X, layout)));
        } else {
            width = Some(Dim::Number(math::floor(layout.width / EMU - 2.0 * DEFAULT_SLIDE_MARGIN)));
        }
        // STEP 4: inches to EMU.
        let to_emu = |value: f64| if value != 0.0 && !value.is_nan() && value < 20.0 { inch_to_emu(value) } else { value };
        let x = to_emu(x);
        let y = to_emu(y);
        if let Some(Dim::Number(value)) = width {
            width = Some(Dim::Number(to_emu(value)));
        }
        if let Some(Dim::Number(value)) = height {
            height = Some(Dim::Number(to_emu(value)));
        }
        // The hyperlinks of the cells get their relationships, row by row.
        for cell in cells.iter_mut().flatten() {
            cell.give_links(link);
        }
        // The grid of cells, with the merged ones that the spans reserve.
        let column_count = first_row_columns;
        let mut grid: Vec<Vec<Slot>> = cells.into_iter().map(|row| row.into_iter().map(Slot::Cell).collect()).collect();
        expand_column_spans(&mut grid);
        expand_row_spans(&mut grid);
        // The XML.
        let cx = width.map_or_else(|| smart_parse(Dim::Percent(75.0), Axis::X, layout), |dim| smart_parse(dim, Axis::X, layout));
        let cy = height.map_or(0.0, |dim| smart_parse(dim, Axis::Y, layout));
        let (x, y) = (smart_parse(Dim::Number(x), Axis::X, layout), smart_parse(Dim::Number(y), Axis::Y, layout));
        let id = (place.tables_before + 1) * place.slide_number + 1;
        let mut xml = format!("<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"{id}\" name=\"{object_name}\"/>");
        xml.push_str("<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp=\"1\"/></p:cNvGraphicFramePr>");
        xml.push_str("  <p:nvPr><p:extLst><p:ext uri=\"{D42A27DB-BD31-4B8C-83A1-F6EECF244321}\"><p14:modId xmlns:p14=\"http://schemas.microsoft.com/office/powerpoint/2010/main\" val=\"1579011935\"/></p:ext></p:extLst></p:nvPr>");
        xml.push_str("</p:nvGraphicFramePr>");
        xml.push_str(&format!(
            "<p:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></p:xfrm>",
            num(or_zero_or(x, EMU)),
            num(or_zero_or(y, EMU)),
            num(or_zero_or(cx, EMU)),
            num(if cy != 0.0 && !cy.is_nan() { cy } else { EMU })
        ));
        xml.push_str("<a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/table\"><a:tbl><a:tblPr/>");
        xml.push_str(&grid_xml(&col_w, width, column_count));
        let height_value = match height {
            Some(Dim::Number(value)) if Dim::Number(value).truthy() => Some(value),
            _ => None,
        };
        let row_count = grid.len();
        for (index, row) in grid.iter().enumerate() {
            let row_height = row_height(&row_h, index, height_value, row_count);
            xml.push_str(&format!("<a:tr h=\"{}\">", num(row_height)));
            for slot in row {
                xml.push_str(&slot_xml(slot, &opt)?);
            }
            xml.push_str("</a:tr>");
        }
        xml.push_str("      </a:tbl>");
        xml.push_str("    </a:graphicData>");
        xml.push_str("  </a:graphic>");
        xml.push_str("</p:graphicFrame>");
        Ok(Self { xml })
    }
}

/// `x || (x === 0 ? 0 : EMU)`.
fn or_zero_or(value: f64, fallback: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else if value.is_nan() {
        fallback
    } else {
        value
    }
}

/// `getSmartParseNumber(opt.x || (opt.x === 0 ? 0 : EMU / 2), ...)`.
fn table_position(dim: Option<Dim>, axis: Axis, layout: &Layout) -> f64 {
    let chosen = match dim {
        Some(dim) if dim.truthy() => dim,
        Some(Dim::Number(value)) if value == 0.0 => Dim::Number(0.0),
        _ => Dim::Number(EMU / 2.0),
    };
    smart_parse(chosen, axis, layout)
}

/// A cell as the grid holds it: its text and its options (a cell given as a string has no options of its own).
#[derive(Debug, Clone)]
struct Cell {
    text: TextContent,
    options: TextOptions,
}

impl Cell {
    /// Step 2 of `addTableDefinition`: the text and options, and the border of the cell with all four sides filled in
    /// (the cell's own, else the table's, else none).
    fn from_input(input: TableCell, table_border: &Option<Borders>) -> Self {
        let (text, mut options) = match input {
            TableCell::Plain(text) => (TextContent::Plain(text), TextOptions::default()),
            TableCell::Cell { text, options } => (text, options.unwrap_or_default()),
        };
        let own = options.border.take();
        let aliased = own.is_none() && matches!(table_border, Some(Borders::Each(_)));
        let source = own.or_else(|| table_border.clone()).unwrap_or(Borders::Each(Vec::new()));
        let sides: Vec<Option<Border>> = (0..4)
            .map(|side| {
                let found = match &source {
                    Borders::One(border) => Some(border),
                    Borders::Each(each) => each.get(side).and_then(Option::as_ref),
                };
                let mut border = match found {
                    Some(border) => Border {
                        kind: Some(border.kind.clone().filter(|kind| !kind.is_empty()).unwrap_or_else(|| "solid".to_owned())),
                        color: Some(border.color.clone().filter(|color| !color.is_empty()).unwrap_or_else(|| DEFAULT_BORDER_COLOR.to_owned())),
                        pt: Some(border.pt.filter(|pt| !pt.is_nan()).unwrap_or(1.0)),
                    },
                    None => Border { kind: Some("none".to_owned()), color: Some(DEFAULT_BORDER_COLOR.to_owned()), pt: Some(1.0) },
                };
                // The cell shares the table's list of borders, which is then written again with `pt || 1`.
                if aliased {
                    border.pt = Some(or(border.pt, 1.0));
                }
                Some(border)
            })
            .collect();
        options.border = Some(Borders::Each(sides));
        Self { text, options }
    }

    /// `createHyperlinkRels` for the cell: the hyperlink of its text, or of each of its runs, gets a relationship.
    fn give_links(&mut self, link: &mut dyn FnMut(&Hyperlink) -> usize) {
        let usable = |options: &TextOptions| {
            options.hyperlink_rid.is_none()
                && options
                    .frame
                    .hyperlink
                    .as_ref()
                    .is_some_and(|hyperlink| hyperlink.url.as_deref().is_some_and(|url| !url.is_empty()) || is_set(hyperlink.slide))
        };
        match &mut self.text {
            TextContent::Plain(_) => {
                if usable(&self.options) {
                    if let Some(hyperlink) = self.options.frame.hyperlink.clone() {
                        self.options.hyperlink_rid = Some(link(&hyperlink));
                    }
                }
            }
            TextContent::Runs(runs) => {
                for run in runs.iter_mut() {
                    if let Some(options) = run.options.as_mut() {
                        if usable(options) {
                            if let Some(hyperlink) = options.frame.hyperlink.clone() {
                                options.hyperlink_rid = Some(link(&hyperlink));
                            }
                        }
                    }
                }
            }
        }
    }

    /// Whether any text or option of the cell contains the word `hyperlink` (`JSON.stringify(rows)` does).
    fn mentions_hyperlink(&self) -> bool {
        let in_text = match &self.text {
            TextContent::Plain(text) => text.contains("hyperlink"),
            TextContent::Runs(runs) => {
                runs.iter().any(|run| run.text.contains("hyperlink") || run.options.as_ref().is_some_and(|options| options.frame.hyperlink.is_some()))
            }
        };
        in_text || self.options.frame.hyperlink.is_some()
    }
}

fn mentions_hyperlink(cells: &[Vec<Cell>]) -> bool {
    cells.iter().flatten().any(Cell::mentions_hyperlink)
}

/// An entry of the grid: a cell, or what a span reserves.
#[derive(Debug, Clone)]
enum Slot {
    Cell(Cell),
    Merge { colspan: Option<usize>, rowspan: Option<usize>, row_continue: Option<usize>, vmerge: bool, hmerge: bool },
}

impl Slot {
    fn colspan(&self) -> Option<usize> {
        match self {
            Slot::Cell(cell) => cell.options.colspan,
            Slot::Merge { colspan, .. } => *colspan,
        }
    }

    fn rowspan(&self) -> Option<usize> {
        match self {
            Slot::Cell(cell) => cell.options.rowspan,
            Slot::Merge { rowspan, .. } => *rowspan,
        }
    }
}

/// Step 3A: a cell with a `colspan` is followed by a merged cell for each column it covers.
fn expand_column_spans(grid: &mut [Vec<Slot>]) {
    for cells in grid.iter_mut() {
        let mut index = 0;
        while index < cells.len() {
            let colspan = cells[index].colspan().filter(|span| *span > 1);
            match colspan {
                Some(span) => {
                    let rowspan = cells[index].rowspan();
                    for offset in 0..span - 1 {
                        cells.insert(index + 1 + offset, Slot::Merge { colspan: None, rowspan, row_continue: None, vmerge: false, hmerge: true });
                    }
                    index += span;
                }
                None => index += 1,
            }
        }
    }
}

/// Step 3B: a cell with a `rowspan` is followed, in the row below it, by a merged cell at its column.
fn expand_row_spans(grid: &mut [Vec<Slot>]) {
    for row in 0..grid.len().saturating_sub(1) {
        let reserved: Vec<(usize, Slot)> = grid[row]
            .iter()
            .enumerate()
            .filter_map(|(column, slot)| {
                let (row_continue, hmerge) = match slot {
                    Slot::Merge { row_continue, hmerge, .. } => (*row_continue, *hmerge),
                    Slot::Cell(_) => (None, false),
                };
                let rowspan = row_continue.filter(|span| *span > 0).or(slot.rowspan()).filter(|span| *span > 1)?;
                Some((column, Slot::Merge { colspan: slot.colspan(), rowspan: None, row_continue: Some(rowspan - 1), vmerge: true, hmerge }))
            })
            .collect();
        for (column, slot) in reserved {
            let below = &mut grid[row + 1];
            let at = column.min(below.len());
            below.insert(at, slot);
        }
    }
}

/// The `a:tblGrid`.
fn grid_xml(col_w: &Option<ColWidths>, width: Option<Dim>, column_count: usize) -> String {
    let mut xml = String::from("<a:tblGrid>");
    let table_width = match width {
        Some(Dim::Number(value)) => value,
        _ => 1.0,
    };
    if let Some(ColWidths::Each(widths)) = col_w {
        for column in 0..column_count {
            let mut value = widths.get(column).map_or(f64::NAN, |width| inch_to_emu(*width));
            if value.is_nan() {
                value = table_width / column_count as f64;
            }
            xml.push_str(&format!("<a:gridCol w=\"{}\"/>", num(round(value))));
        }
    } else {
        let mut each = EMU;
        if width.is_some_and(Dim::truthy) {
            each = round(table_width / column_count as f64);
        }
        for _ in 0..column_count {
            xml.push_str(&format!("<a:gridCol w=\"{}\"/>", num(each)));
        }
    }
    xml.push_str("</a:tblGrid>");
    xml
}

/// The height of a row: its own `rowH`, the one for all rows, else the table's height shared out.
fn row_height(row_h: &Option<RowHeights>, index: usize, height: Option<f64>, row_count: usize) -> f64 {
    if let Some(RowHeights::Each(each)) = row_h {
        if let Some(own) = each.get(index).filter(|own| is_set(Some(**own))) {
            return inch_to_emu(*own);
        }
    }
    let scalar = match row_h {
        Some(RowHeights::One(one)) if is_set(Some(*one)) => Some(*one),
        Some(RowHeights::Each(each)) if each.is_empty() => Some(0.0),
        Some(RowHeights::Each(each)) if each.len() == 1 => Some(each[0]),
        _ => None,
    };
    if let Some(scalar) = scalar.filter(|scalar| !scalar.is_nan()) {
        return inch_to_emu(scalar);
    }
    match height {
        Some(height) => round(inch_to_emu(height) / row_count as f64),
        None => 0.0,
    }
}

/// `a.valign.replace(/^c$/i, 'ctr')...`: the anchor of a cell.
fn cell_anchor(valign: &str) -> String {
    let mut anchor = valign.to_owned();
    if anchor.eq_ignore_ascii_case("c") || anchor.eq_ignore_ascii_case("m") {
        anchor = "ctr".to_owned();
    }
    for (from, to) in [("center", "ctr"), ("middle", "ctr"), ("top", "t"), ("btm", "b"), ("bottom", "b")] {
        anchor = anchor.replacen(from, to, 1);
    }
    anchor
}

/// The margin of a cell: inches, or points when the first value is a point or more.
fn cell_margin_xml(margin: &[f64]) -> String {
    let at = |index: usize| margin.get(index).copied().unwrap_or(f64::NAN);
    if at(0) >= 1.0 {
        format!(
            " marL=\"{}\" marR=\"{}\" marT=\"{}\" marB=\"{}\"",
            num(val_to_pts(at(3))),
            num(val_to_pts(at(1))),
            num(val_to_pts(at(0))),
            num(val_to_pts(at(2)))
        )
    } else {
        format!(
            " marL=\"{}\" marR=\"{}\" marT=\"{}\" marB=\"{}\"",
            num(inch_to_emu(at(3))),
            num(inch_to_emu(at(1))),
            num(inch_to_emu(at(0))),
            num(inch_to_emu(at(2)))
        )
    }
}

/// The options a cell lacks are the table's (`['align', 'bold', 'border', 'color', 'fill', 'fontFace', 'fontSize',
/// 'margin', 'textDirection', 'underline', 'valign']`).
fn inherit_table_options(cell: &mut TextOptions, table: &TextOptions) {
    let has = |text: &Option<String>| text.as_deref().is_some_and(|text| !text.is_empty());
    if has(&table.align) && !has(&cell.align) {
        cell.align.clone_from(&table.align);
    }
    cell.bold = cell.bold || table.bold;
    if has(&table.color) && !has(&cell.color) {
        cell.color.clone_from(&table.color);
    }
    if table.frame.fill.is_some() && cell.frame.fill.is_none() {
        cell.frame.fill.clone_from(&table.frame.fill);
    }
    if has(&table.font_face) && !has(&cell.font_face) {
        cell.font_face.clone_from(&table.font_face);
    }
    if is_set(table.font_size) && cell.font_size.is_none_or(f64::is_nan) {
        cell.font_size = table.font_size;
    }
    if table.margin.is_some() && cell.margin.is_none() {
        cell.margin.clone_from(&table.margin);
    }
    if has(&table.text_direction) && !has(&cell.text_direction) {
        cell.text_direction.clone_from(&table.text_direction);
    }
    let underlined = |underline: &Option<Underline>| match underline {
        Some(Underline::Flag(on)) => *on,
        Some(Underline::Style { .. }) => true,
        Some(Underline::Text(text)) => !text.is_empty(),
        None => false,
    };
    if underlined(&table.underline) && !underlined(&cell.underline) {
        cell.underline.clone_from(&table.underline);
    }
    if has(&table.valign) && !has(&cell.valign) {
        cell.valign.clone_from(&table.valign);
    }
}

/// One `a:tc`.
fn slot_xml(slot: &Slot, table: &TextOptions) -> Result<String, String> {
    let span = |value: Option<usize>| value.filter(|value| *value > 1);
    let (row_span, grid_span, vmerge, hmerge) = match slot {
        Slot::Cell(cell) => (span(cell.options.rowspan), span(cell.options.colspan), false, false),
        Slot::Merge { colspan, rowspan, vmerge, hmerge, .. } => (span(*rowspan), span(*colspan), *vmerge, *hmerge),
    };
    let mut attributes = Vec::new();
    if let Some(value) = row_span {
        attributes.push(format!("rowSpan=\"{value}\""));
    }
    if let Some(value) = grid_span {
        attributes.push(format!("gridSpan=\"{value}\""));
    }
    if vmerge {
        attributes.push("vMerge=\"1\"".to_owned());
    }
    if hmerge {
        attributes.push("hMerge=\"1\"".to_owned());
    }
    let attributes = if attributes.is_empty() { String::new() } else { format!(" {}", attributes.join(" ")) };
    let cell = match slot {
        Slot::Merge { .. } => return Ok(format!("<a:tc{attributes}><a:tcPr/></a:tc>")),
        Slot::Cell(cell) => cell,
    };
    let mut options = cell.options.clone();
    inherit_table_options(&mut options, table);
    let anchor = options.valign.as_deref().filter(|valign| !valign.is_empty()).map(|valign| format!(" anchor=\"{}\"", cell_anchor(valign))).unwrap_or_default();
    let direction = options
        .text_direction
        .as_deref()
        .filter(|direction| !direction.is_empty() && *direction != "horz")
        .map(|direction| format!(" vert=\"{direction}\""))
        .unwrap_or_default();
    let margin = match &options.margin {
        Some(Margin::All(all)) => vec![*all; 4],
        Some(Margin::Each(each)) => each.clone(),
        None => DEFAULT_CELL_MARGIN.to_vec(),
    };
    let fill = options.frame.fill.as_ref().map(|fill: &Fill| color_selection(fill)).unwrap_or_default();
    let borders = options.border.clone();
    // The text: the cell's options come first, the options of the runs after them.
    let mut arena = vec![options];
    let mut runs = Vec::new();
    match &cell.text {
        TextContent::Plain(text) => runs.push(Run { text: text.clone(), opt: 0 }),
        TextContent::Runs(items) => {
            for item in items {
                match &item.options {
                    Some(own) => {
                        arena.push(own.clone());
                        runs.push(Run { text: item.text.clone(), opt: arena.len() - 1 });
                    }
                    None => runs.push(Run { text: item.text.clone(), opt: 0 }),
                }
            }
        }
    }
    let body = text_body_xml(BodyKind::Cell, &mut arena, &runs, &BodyProperties::default())?;
    let mut xml = format!("<a:tc{attributes}>{body}<a:tcPr{}{anchor}{direction}>", cell_margin_xml(&margin));
    if let Some(Borders::Each(sides)) = &borders {
        for (index, name) in [(3, "lnL"), (1, "lnR"), (0, "lnT"), (2, "lnB")] {
            let side = sides.get(index).and_then(Option::as_ref);
            match side.filter(|side| side.kind.as_deref() != Some("none")) {
                Some(side) => {
                    xml.push_str(&format!("<a:{name} w=\"{}\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\">", num(val_to_pts(side.pt.unwrap_or(f64::NAN)))));
                    xml.push_str(&format!("<a:solidFill>{}</a:solidFill>", color_element(side.color.as_deref().unwrap_or(""), "")));
                    xml.push_str(&format!("<a:prstDash val=\"{}\"/>", if side.kind.as_deref() == Some("dash") { "sysDash" } else { "solid" }));
                    xml.push_str("<a:round/><a:headEnd type=\"none\" w=\"med\" len=\"med\"/><a:tailEnd type=\"none\" w=\"med\" len=\"med\"/>");
                    xml.push_str(&format!("</a:{name}>"));
                }
                None => xml.push_str(&format!("<a:{name} w=\"0\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:noFill/></a:{name}>")),
            }
        }
    }
    xml.push_str(&fill);
    xml.push_str("  </a:tcPr>");
    xml.push_str(" </a:tc>");
    Ok(xml)
}

#[cfg(test)]
mod tests {
    use super::super::text::TextRun;
    use super::*;

    fn wide() -> Layout {
        Layout { name: "custom".to_owned(), width: 12_192_000.0, height: 6_858_000.0 }
    }

    fn table(rows: Vec<Vec<TableCell>>, options: TableOptions) -> Result<String, String> {
        let layout = wide();
        let mut no_links = |_: &Hyperlink| -> usize { panic!("no hyperlink expected") };
        TableObject::new(rows, options, &TablePlacement { tables_before: 0, slide_number: 3, layout: &layout }, &mut no_links)
            .map(|object| object.xml().to_owned())
    }

    fn cell(text: &str, options: TextOptions) -> TableCell {
        TableCell::Cell { text: TextContent::Plain(text.to_owned()), options: Some(options) }
    }

    fn framed(x: f64, y: f64, w: f64, h: f64) -> TableOptions {
        let frame = super::super::shapes::ShapeOptions {
            x: Some(Dim::Number(x)),
            y: Some(Dim::Number(y)),
            w: Some(Dim::Number(w)),
            h: Some(Dim::Number(h)),
            ..Default::default()
        };
        TableOptions { text: TextOptions { frame, ..TextOptions::default() }, ..TableOptions::default() }
    }

    #[test]
    fn a_table_frame_has_the_grid_the_rows_and_the_cells() {
        let options =
            TableOptions { col_w: Some(ColWidths::Each(vec![2.0, 3.0])), row_h: Some(RowHeights::Each(vec![0.5, 0.75])), ..framed(1.0, 1.0, 5.0, 1.25) };
        let rows = vec![
            vec![TableCell::Plain("a".to_owned()), TableCell::Plain("b".to_owned())],
            vec![TableCell::Plain("c".to_owned()), TableCell::Plain("d".to_owned())],
        ];
        let xml = table(rows, options).expect("table");
        assert!(xml.starts_with("<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"4\" name=\"Table 0\"/>"));
        assert!(xml.contains("<p:xfrm><a:off x=\"914400\" y=\"914400\"/><a:ext cx=\"4572000\" cy=\"1143000\"/></p:xfrm>"));
        assert!(xml.contains("<a:tblPr/><a:tblGrid><a:gridCol w=\"1828800\"/><a:gridCol w=\"2743200\"/></a:tblGrid><a:tr h=\"457200\">"));
        assert!(xml.contains("<a:tr h=\"685800\">"));
        assert!(xml.contains("<a:tcPr marL=\"91440\" marR=\"91440\" marT=\"45720\" marB=\"45720\">"));
        assert!(
            xml.contains("<a:endParaRPr lang=\"en-US\" sz=\"1200\" dirty=\"0\">") || xml.contains("<a:endParaRPr lang=\"en-US\" sz=\"1200\" dirty=\"0\"/>")
        );
        assert!(xml.ends_with("</a:tcPr> </a:tc></a:tr>      </a:tbl>    </a:graphicData>  </a:graphic></p:graphicFrame>"));
    }

    #[test]
    fn a_cell_carries_its_fill_borders_anchor_and_margin() {
        let options = TextOptions {
            frame: super::super::shapes::ShapeOptions { fill: Some(Fill::color("EEEEEE")), ..Default::default() },
            valign: Some("middle".to_owned()),
            margin: Some(Margin::Each(vec![0.1, 0.2, 0.1, 0.2])),
            border: Some(Borders::Each(vec![
                Some(Border { kind: Some("solid".to_owned()), color: Some("112233".to_owned()), pt: Some(1.5) }),
                None,
                None,
                Some(Border { kind: Some("dash".to_owned()), color: Some("445566".to_owned()), pt: Some(1.0) }),
            ])),
            ..TextOptions::default()
        };
        let xml = table(vec![vec![cell("x", options)]], framed(0.5, 0.5, 2.0, 1.0)).expect("table");
        assert!(xml.contains("<a:tcPr marL=\"182880\" marR=\"182880\" marT=\"91440\" marB=\"91440\" anchor=\"ctr\"><a:lnL w=\"12700\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:srgbClr val=\"445566\"/></a:solidFill><a:prstDash val=\"sysDash\"/>"));
        assert!(xml.contains("</a:lnL><a:lnR w=\"0\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:noFill/></a:lnR><a:lnT w=\"19050\""));
        assert!(xml.contains(
            "<a:lnT w=\"19050\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:srgbClr val=\"112233\"/></a:solidFill><a:prstDash val=\"solid\"/>"
        ));
        assert!(xml.contains("</a:lnB><a:solidFill><a:srgbClr val=\"EEEEEE\"/></a:solidFill>  </a:tcPr>"));
    }

    #[test]
    fn a_cell_without_borders_has_none_on_all_sides() {
        let xml = table(vec![vec![TableCell::Cell { text: TextContent::Plain("x".to_owned()), options: None }]], TableOptions::default()).expect("table");
        assert_eq!(xml.matches("w=\"0\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:noFill/>").count(), 4);
    }

    #[test]
    fn spans_reserve_merged_cells_in_the_row_and_the_rows_below() {
        let spanned = TextOptions { colspan: Some(2), rowspan: Some(2), ..TextOptions::default() };
        let rows = vec![vec![cell("a", spanned), TableCell::Plain("b".to_owned())], vec![TableCell::Plain("c".to_owned())]];
        let xml = table(rows, framed(0.5, 0.5, 3.0, 2.0)).expect("table");
        assert!(xml.contains("<a:tc rowSpan=\"2\" gridSpan=\"2\">"));
        assert!(xml.contains("<a:tc rowSpan=\"2\" hMerge=\"1\"><a:tcPr/></a:tc>"));
        assert!(xml.contains("<a:tc gridSpan=\"2\" vMerge=\"1\"><a:tcPr/></a:tc>"));
        assert!(xml.contains("<a:tc hMerge=\"1\" vMerge=\"1\">") || xml.contains("<a:tc vMerge=\"1\" hMerge=\"1\">"));
    }

    #[test]
    fn a_table_without_a_width_is_as_wide_as_the_slide_less_its_margins() {
        let xml = table(vec![vec![TableCell::Plain("a".to_owned())]], TableOptions::default()).expect("table");
        assert!(xml.contains("<p:xfrm><a:off x=\"457200\" y=\"457200\"/><a:ext cx=\"10972800\" cy=\"914400\"/></p:xfrm>"));
        assert!(table(Vec::new(), TableOptions::default()).is_err());
    }

    #[test]
    fn the_word_hyperlink_in_a_cell_stops_the_default_colour() {
        let plain = table(vec![vec![TableCell::Plain("a".to_owned())]], TableOptions::default()).expect("table");
        assert!(plain.contains("<a:srgbClr val=\"000000\"/>"));
        let mentioning = table(vec![vec![TableCell::Plain("a hyperlink".to_owned())]], TableOptions::default()).expect("table");
        assert!(!mentioning.contains("<a:solidFill>"));
    }

    #[test]
    fn cell_runs_and_their_links_are_written_by_the_text_body() {
        let link = Hyperlink { url: Some("https://x.test".to_owned()), ..Hyperlink::default() };
        let run = TextRun {
            text: "go".to_owned(),
            options: Some(TextOptions { frame: super::super::shapes::ShapeOptions { hyperlink: Some(link), ..Default::default() }, ..TextOptions::default() }),
        };
        let layout = wide();
        let mut asked = 0;
        let mut give = |_: &Hyperlink| -> usize {
            asked += 1;
            7
        };
        let object = TableObject::new(
            vec![vec![TableCell::Cell { text: TextContent::Runs(vec![run]), options: None }]],
            TableOptions::default(),
            &TablePlacement { tables_before: 0, slide_number: 1, layout: &layout },
            &mut give,
        )
        .expect("table");
        assert_eq!(asked, 1);
        assert!(object.xml().contains("<a:hlinkClick r:id=\"rId7\""));
    }
}
