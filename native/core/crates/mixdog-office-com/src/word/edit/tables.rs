//! The table operations of `Invoke-WordOperation` and their helpers: `add_table`, `set_table_cell`, `set_table_style`,
//! `merge_table_cells`, `set_table_cell_style`, `insert_table_row`, `delete_table_row`, `insert_table_column`,
//! `delete_table_column`, `fit_table`, with `Word-TableCell`, `Word-TableSummary`, `Word-TableAt`, `Word-MissingRowMessage`,
//! `Word-MissingColumnMessage`, `Set-WordTableColumnAlignments`, `Set-WordTableDefaultRules` and `Set-WordTableBorders`.

use super::Com;
use super::Value;
use super::append;
use super::cast_int;
use super::cast_single;
use super::color_of;
use super::flag;
use super::formatting;
use super::lower;
use super::ordered;
use super::prop;
use super::r4;
use super::same;
use super::text_of;
use super::truthy;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::ps::collate;
use crate::ps::convert;
use crate::ps::pipeline_items;

/// The sides of a table's borders by the portable writer's names.
const SIDES: [(&str, i32); 6] = [("top", -1), ("left", -2), ("bottom", -3), ("right", -4), ("insideH", -5), ("insideV", -6)];

/// `$value -eq $false`: a boolean false, a zero, or the text "False".
pub(super) fn eq_false(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => !flag,
        Value::Int(number) => *number == 0,
        Value::Long(number) => *number == 0,
        Value::Double(number) => *number == 0.0,
        Value::Single(number) => *number == 0.0,
        Value::Decimal(number) => number.is_zero(),
        Value::String(text) => same(text, "False"),
        _ => false,
    }
}

/// `$value -eq $true`: a boolean true, a one, or the text "True".
fn eq_true(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::Int(number) => *number == 1,
        Value::Long(number) => *number == 1,
        Value::Double(number) => *number == 1.0,
        Value::Single(number) => *number == 1.0,
        Value::String(text) => same(text, "True"),
        _ => false,
    }
}

/// `[string]$value` of a Word count or index the result reports as Word answered it.
fn answered(value: &Com) -> Result<Value> {
    crate::word::ps_value(value, "System.Object")
}

/// A table alignment name: centre, right, else left.
fn table_alignment(name: &Value) -> i32 {
    match lower(&text_of(name)).as_str() {
        "center" => 1,
        "right" => 2,
        _ => 0,
    }
}

/// `Word-MissingRowMessage`.
fn missing_row_message(table: &Com, table_number: &Value, row: i32, operation: &str) -> Result<String> {
    let rows = super::count_of_collection(&table.member("Rows")?)?;
    let mut message = format!("DOCX table {} is {}, so it has no row {row}", text_of(table_number), table_summary(table)?);
    if operation == "insert_table_row" {
        message.push_str(&format!(": insert_table_row row is the position the new row takes, 1 to {} ({} adds it at the end)", rows + 1, rows + 1));
    }
    Ok(message.replace("table  is", "table is"))
}

/// `Word-MissingColumnMessage`.
fn missing_column_message(table: &Com, table_number: &Value, column: i32, operation: &str) -> Result<String> {
    let columns = super::count_of_collection(&table.member("Columns")?)?;
    let mut message = format!("DOCX table {} is {}, so it has no column {column}", text_of(table_number), table_summary(table)?);
    if operation == "insert_table_column" {
        message.push_str(&format!(
            ": insert_table_column column is the position the new column takes, 1 to {} ({} adds it at the end)",
            columns + 1,
            columns + 1
        ));
    }
    Ok(message)
}

/// `Word-TableSummary`: a table as a caller can pick it out of the page: its size and the words it starts with.
fn table_summary(table: &Com) -> Result<String> {
    let rows = super::count_of_collection(&table.member("Rows")?)?;
    let columns = super::count_of_collection(&table.member("Columns")?)?;
    let start = (|| -> Result<String> {
        let words = super::string(&table.call_member("Cell", &[Com::I4(1), Com::I4(1)])?.member("Range")?.member("Text")?);
        let mut spaced = String::new();
        let mut in_run = false;
        for letter in words.chars() {
            if matches!(letter, '\r' | '\u{7}' | '\n') {
                if !in_run {
                    spaced.push(' ');
                }
                in_run = true;
            } else {
                in_run = false;
                spaced.push(letter);
            }
        }
        Ok(spaced.trim().to_owned())
    })()
    .unwrap_or_default();
    let units: Vec<u16> = start.encode_utf16().collect();
    let start = if units.len() > 24 { String::from_utf16_lossy(&units[..24]) } else { start };
    let mut summary = format!("{rows}\u{D7}{columns}");
    if !start.is_empty() {
        summary.push_str(&format!(" starting \"{start}\""));
    }
    Ok(summary)
}

/// `Word-TableAt`: the table a number names, or the document's tables listed.
pub(super) fn table_at(document: &Obj, number: &Value) -> Result<Com> {
    let count = super::count_of_collection(&document.get("Tables")?)?;
    let index = cast_int(number)?;
    if index >= 1 && index <= count {
        return super::item(&document.get("Tables")?, index);
    }
    let mut held = Vec::new();
    for position in 1..=count.min(6) {
        held.push(format!("{position}: {}", table_summary(&super::item(&document.get("Tables")?, position)?)?));
    }
    let listing = if held.is_empty() { String::new() } else { format!(" ({})", held.join("; ")) };
    Err(Error::host(format!("DOCX table {} not found: the document holds {count} table(s){listing}", text_of(number))))
}

/// `Word-TableCell`: a table's cell by its row and its position in the row, or the reason there is none.
pub(super) fn table_cell(table: &Com, row: i32, column: i32) -> Result<Com> {
    match table.call_member("Cell", &[Com::I4(row), Com::I4(column)]) {
        Ok(cell) => Ok(cell),
        Err(_) => {
            let rows = super::count_of_collection(&table.member("Rows")?)?;
            if row < 1 || row > rows {
                return Err(Error::host(missing_row_message(table, &Value::Null, row, "")?));
            }
            let mut held = 0;
            for cell in super::items_of(&table.member("Range")?.member("Cells")?)? {
                if super::int(&cell.member("RowIndex")?)? == row {
                    held += 1;
                }
            }
            Err(Error::host(format!(
                "Word table row {row} holds {held} cell(s) as it stands, so it has no cell {column}: a merge across columns joins cells and moves the later ones left; merge a row from its right end first, or name the cell by its new position"
            )))
        }
    }
}

/// `Set-WordTableColumnAlignments`: with every column named, the alignment most of them share goes on the whole table at
/// once and only the other columns are set cell by cell.
fn set_column_alignments(table: &Com, alignments: &Value) -> Result<()> {
    let values = pipeline_items(alignments);
    let column_count = super::count_of_collection(&table.member("Columns")?)?;
    let row_count = super::count_of_collection(&table.member("Rows")?)?;
    let codes: Vec<i32> = (0..column_count.min(values.len() as i32))
        .map(|at| match lower(&text_of(&values[at as usize])).as_str() {
            "center" => 1,
            "right" => 2,
            "justify" => 3,
            _ => 0,
        })
        .collect();
    let mut shared: Option<i32> = None;
    if codes.len() as i32 == column_count && column_count > 1 {
        let listed: Vec<Value> = codes.iter().map(|code| Value::Int(*code)).collect();
        let name = collate::groups_by_count_descending(&listed).first().map(|group| group.name.clone()).unwrap_or_default();
        shared = Some(convert::to_int(&Value::String(name)).map_err(Error::host)?);
        let whole = table
            .member("Range")
            .and_then(|range| range.member("ParagraphFormat"))
            .and_then(|format| format.set_member("Alignment", Com::I4(shared.unwrap_or(0))));
        if whole.is_err() {
            shared = None;
        }
    }
    for column in 1..=codes.len() as i32 {
        if shared == Some(codes[(column - 1) as usize]) {
            continue;
        }
        for row in 1..=row_count {
            let _ = (|| -> Result<()> {
                table
                    .call_member("Cell", &[Com::I4(row), Com::I4(column)])?
                    .member("Range")?
                    .member("ParagraphFormat")?
                    .set_member("Alignment", Com::I4(codes[(column - 1) as usize]))
            })();
        }
    }
    Ok(())
}

/// `Set-WordTableDefaultRules`: an unstyled table reads the same on both backends: a rule under the header and hairlines
/// between rows (the portable writer's default borders).
fn set_default_rules(table: &Com) {
    let _ = (|| -> Result<()> {
        table.member("Borders")?.set_member("Enable", Com::I4(0))?;
        let bottom = super::item(&table.member("Borders")?, -3)?;
        bottom.set_member("LineStyle", Com::I4(1))?;
        bottom.set_member("LineWidth", Com::I4(4))?;
        bottom.set_member("Color", Com::I4(convert::color_value("BFC5CB").map_err(Error::host)?))?;
        let inside = super::item(&table.member("Borders")?, -5)?;
        inside.set_member("LineStyle", Com::I4(1))?;
        inside.set_member("LineWidth", Com::I4(2))?;
        inside.set_member("Color", Com::I4(convert::color_value("D8DCE0").map_err(Error::host)?))
    })();
}

/// The line width of Word's own set that holds a size in eighths of a point.
fn line_width_for(size: i32) -> i32 {
    match size {
        ..=2 => 2,
        3..=4 => 4,
        5..=6 => 6,
        7..=8 => 8,
        9..=12 => 12,
        13..=18 => 18,
        19..=24 => 24,
        25..=36 => 36,
        _ => 48,
    }
}

/// `Set-WordTableBorders`: explicit table borders in the portable writer's vocabulary: one spec for every side, or an object
/// naming sides, each { enabled?, style?, size?, color? }.
fn set_borders(table: &Com, borders: &Value) -> Result<()> {
    // A bare true or a style name is one spec for every side; only an object can name sides.
    let named = match borders {
        Value::Object(object) => object.entries.iter().any(|(name, _)| !name.is_empty() && SIDES.iter().any(|(side, _)| same(side, name))),
        _ => false,
    };
    let uniform = !named;
    for (side, index) in SIDES {
        let spec = if uniform { borders.clone() } else { prop(borders, side) };
        let edge = super::item(&table.member("Borders")?, index)?;
        let style = if spec.is_null() {
            "none".to_owned()
        } else if let Value::String(text) = &spec {
            text.clone()
        } else if truthy(&prop(&spec, "style")) {
            text_of(&prop(&spec, "style"))
        } else {
            "single".to_owned()
        };
        if eq_false(&spec) || eq_false(&prop(&spec, "enabled")) || same(&style, "none") || same(&style, "nil") {
            let _ = edge.set_member("LineStyle", Com::I4(0));
            continue;
        }
        let _ = (|| -> Result<()> {
            let line_style = match lower(&style).as_str() {
                "dashed" => 3,
                "dotted" => 2,
                "double" => 7,
                _ => 1,
            };
            edge.set_member("LineStyle", Com::I4(line_style))?;
            let size = if !matches!(spec, Value::String(_)) && truthy(&prop(&spec, "size")) { cast_int(&prop(&spec, "size"))? } else { 4 };
            edge.set_member("LineWidth", Com::I4(line_width_for(size)))?;
            if !matches!(spec, Value::String(_)) && truthy(&prop(&spec, "color")) {
                edge.set_member("Color", color_of(&prop(&spec, "color"))?)?;
            }
            Ok(())
        })();
    }
    Ok(())
}

/// `[single]$size * 1.3`: the portable writer's line pitch, one exact line of 1.3 times the size (a double, as the script's
/// arithmetic makes it).
fn line_pitch(size: f32) -> Com {
    Com::R8(f64::from(size) * 1.3)
}

/// The column widths of an unsized table: the portable writer's rule (naturalTableColumnWidths) on Word's own measure.
fn share_column_widths(table: &Com, columns: i32) -> Result<()> {
    let setup = super::item(&table.member("Range")?.member("Sections")?, 1)?.member("PageSetup")?;
    let usable: f32 =
        super::single(&setup.member("PageWidth")?)? - super::single(&setup.member("LeftMargin")?)? - super::single(&setup.member("RightMargin")?)?;
    table.member("Columns")?.call_member("AutoFit", &[])?;
    let mut natural: Vec<f64> = Vec::new();
    for column in 1..=columns {
        natural.push(super::double(&super::item(&table.member("Columns")?, column)?.member("Width")?)?);
    }
    let total: f64 = natural.iter().sum();
    let equal = usable / columns as f32;
    let widths: Vec<f32> = if natural.iter().all(|width| *width <= f64::from(equal)) {
        vec![equal; columns as usize]
    } else if total <= f64::from(usable) {
        natural.iter().map(|width| (*width + (f64::from(usable) - total) / f64::from(columns)) as f32).collect()
    } else {
        table.call_member("AutoFitBehavior", &[Com::I4(2)])?;
        Vec::new()
    };
    if !widths.is_empty() {
        table.call_member("AutoFitBehavior", &[Com::I4(0)])?;
        for column in 1..=columns {
            super::item(&table.member("Columns")?, column)?.set_member("Width", Com::R4(widths[(column - 1) as usize]))?;
        }
    }
    Ok(())
}

/// `add_table`.
pub(super) fn add_table(document: &Obj, op: &Value) -> Result<Value> {
    let values = pipeline_items(&prop(op, "values"));
    let rows_given = prop(op, "rows");
    let rows = if truthy(&rows_given) {
        cast_int(&rows_given)?
    } else if !values.is_empty() {
        values.len() as i32
    } else {
        1
    };
    let columns_given = prop(op, "columns");
    let columns = if truthy(&columns_given) {
        cast_int(&columns_given)?
    } else if !values.is_empty() {
        values.iter().map(|row| pipeline_items(row).len() as i32).max().unwrap_or(1).max(1)
    } else {
        1
    };
    let range = if truthy(&prop(op, "paragraph")) {
        let range = super::item(&document.get("Paragraphs")?, cast_int(&prop(op, "paragraph"))?)?.member("Range")?.member("Duplicate")?;
        range.call_member("Collapse", &[Com::I4(0)])?;
        range
    } else {
        // A second table added in a row went right after the first and read back as one (tableCount 1).
        let paragraphs = document.get("Paragraphs")?;
        let at = append::end_paragraph(document, true)?;
        let range = super::item(&paragraphs, at)?.member("Range")?.member("Duplicate")?;
        range.call_member("Collapse", &[Com::I4(1)])?;
        range
    };
    let table = document.get("Tables")?.call_member("Add", &[range, Com::I4(rows), Com::I4(columns)])?;
    for row in 1..=rows {
        for column in 1..=columns {
            if row as usize <= values.len() && column as usize <= pipeline_items(&values[(row - 1) as usize]).len() {
                let cells = pipeline_items(&values[(row - 1) as usize]);
                table
                    .call_member("Cell", &[Com::I4(row), Com::I4(column)])?
                    .member("Range")?
                    .set_member("Text", Com::from(text_of(&cells[(column - 1) as usize])))?;
            }
        }
    }
    let props = prop(op, "properties");
    let mut style_not_found: Vec<String> = Vec::new();
    if truthy(&prop(&props, "style")) {
        style_not_found.extend(formatting::set_style(&table, &text_of(&prop(&props, "style"))));
    }
    if truthy(&prop(&props, "textStyle")) {
        style_not_found.extend(formatting::set_style(&table.member("Range")?, &text_of(&prop(&props, "textStyle"))));
    }
    if truthy(&prop(&props, "fontName")) {
        formatting::set_latin_font(&table.member("Range")?.member("Font")?, &text_of(&prop(&props, "fontName")))?;
    }
    if truthy(&prop(&props, "fontNameEastAsia")) {
        table.member("Range")?.member("Font")?.set_member("NameFarEast", Com::from(text_of(&prop(&props, "fontNameEastAsia"))))?;
    }
    let font_size = prop(&props, "fontSize");
    if truthy(&font_size) {
        table.member("Range")?.member("Font")?.set_member("Size", r4(&font_size)?)?;
    }
    if truthy(&prop(&props, "color")) {
        table.member("Range")?.member("Font")?.set_member("Color", color_of(&prop(&props, "color"))?)?;
    }
    if !prop(&props, "spacingAfter").is_null() {
        table.member("Range")?.member("ParagraphFormat")?.set_member("SpaceAfter", r4(&prop(&props, "spacingAfter"))?)?;
    }
    // The portable writer's line pitch: one exact line of 1.3x the size in every cell.
    table.member("Range")?.member("ParagraphFormat")?.set_member("LineSpacingRule", Com::I4(4))?;
    let pitch = line_pitch(if truthy(&font_size) { cast_single(&font_size)? } else { 11.0 });
    table.member("Range")?.member("ParagraphFormat")?.set_member("LineSpacing", pitch)?;
    // The portable writer's widow and orphan control, row by row. The rows the header takes: a two-level header is two.
    let header_rows = if truthy(&prop(&props, "headerRows")) { 1_i32.max((rows - 1).min(cast_int(&prop(&props, "headerRows"))?)) } else { 1 };
    for row in 1..=rows {
        let keep = if row < rows { rows <= 6 || row <= header_rows + 1 || row == rows - 1 } else { truthy(&prop(&props, "keepWithNext")) };
        if keep {
            super::item(&table.member("Rows")?, row)?.member("Range")?.member("ParagraphFormat")?.set_member("KeepWithNext", Com::I4(-1))?;
        }
    }
    // A row reads from its top, and the header row sits on its rule (bottom).
    let _ = table.member("Range").and_then(|range| range.member("Cells")).and_then(|cells| cells.set_member("VerticalAlignment", Com::I4(0)));
    let repeat_header = prop(&props, "repeatHeader");
    // The header rows are set apart by weight unless the caller says otherwise.
    if rows > 1 && !eq_false(&prop(&props, "headerBold")) && !eq_false(&repeat_header) {
        for row in 1..=header_rows {
            let _ = super::item(&table.member("Rows")?, row)
                .and_then(|found| found.member("Cells"))
                .and_then(|cells| cells.set_member("VerticalAlignment", Com::I4(3)));
            let _ = super::item(&table.member("Rows")?, row)
                .and_then(|found| found.member("Range"))
                .and_then(|range| range.member("Font"))
                .and_then(|font| font.set_member("Bold", Com::I4(-1)));
        }
    }
    // A style the document does not hold draws the default rules too, as the portable writer does.
    let unstyled = !truthy(&prop(&props, "style")) || style_not_found.iter().any(|name| same(name, &text_of(&prop(&props, "style"))));
    if unstyled && !(truthy(&prop(&props, "borders")) || truthy(&prop(&props, "shading"))) {
        set_default_rules(&table);
    }
    if truthy(&prop(&props, "alignment")) {
        table.member("Rows")?.set_member("Alignment", Com::I4(table_alignment(&prop(&props, "alignment"))))?;
    }
    if truthy(&prop(&props, "columnAlignments")) {
        set_column_alignments(&table, &prop(&props, "columnAlignments"))?;
    }
    // A layout grid: every rule off, no fill, no style (the portable writer's isLayoutTable).
    let mut layout_grid = false;
    if truthy(&prop(&props, "borders")) && !truthy(&prop(&props, "style")) && !truthy(&prop(&props, "shading")) {
        let borders = prop(&props, "borders");
        layout_grid = eq_false(&prop(&borders, "enabled"))
            || SIDES.iter().all(|(side, _)| {
                let spec = prop(&borders, side);
                !spec.is_null() && eq_false(&prop(&spec, "enabled"))
            });
    }
    // Room before a column of words that follows a column of figures, as the portable writer gives it. Set before the
    // widths, so Word's measure counts it.
    if truthy(&prop(&props, "columnAlignments")) && !layout_grid {
        let alignments: Vec<String> = pipeline_items(&prop(&props, "columnAlignments")).iter().map(|name| lower(&text_of(name))).collect();
        for column in 2..=columns.min(alignments.len() as i32) {
            if alignments[(column - 2) as usize] == "right" && matches!(alignments[(column - 1) as usize].as_str(), "left" | "justify") {
                for row in 1..=rows {
                    let _ = table.call_member("Cell", &[Com::I4(row), Com::I4(column)]).and_then(|cell| cell.set_member("LeftPadding", Com::R4(13.4)));
                }
            }
        }
    }
    let widths = pipeline_items(&prop(&props, "columnWidths"));
    if truthy(&prop(&props, "columnWidths")) {
        for column in 1..=columns.min(widths.len() as i32) {
            super::item(&table.member("Columns")?, column)?.set_member("Width", r4(&widths[(column - 1) as usize])?)?;
        }
    } else if columns > 1 {
        // Columns.AutoFit measures at once: AutoFitBehavior alone leaves a hidden Word's widths unchanged.
        let _ = share_column_widths(&table, columns);
    }
    if truthy(&prop(&props, "rowHeights")) {
        let heights = pipeline_items(&prop(&props, "rowHeights"));
        for row in 1..=rows.min(heights.len() as i32) {
            super::item(&table.member("Rows")?, row)?.call_member("SetHeight", &[r4(&heights[(row - 1) as usize])?, Com::I4(1)])?;
        }
    }
    if truthy(&prop(&props, "borders")) {
        set_borders(&table, &prop(&props, "borders"))?;
    }
    if truthy(&prop(&props, "shading")) {
        table.member("Shading")?.set_member("BackgroundPatternColor", color_of(&prop(&props, "shading"))?)?;
    }
    // A layout grid registers with the text around it: its outer cells drop the padding on the page side.
    if layout_grid {
        for row in 1..=rows {
            let _ = table.call_member("Cell", &[Com::I4(row), Com::I4(1)]).and_then(|cell| cell.set_member("LeftPadding", Com::I4(0)));
            let _ = table.call_member("Cell", &[Com::I4(row), Com::I4(columns)]).and_then(|cell| cell.set_member("RightPadding", Com::I4(0)));
        }
    }
    // The first row is the header: it repeats on every continuation page unless the caller says the row is data.
    if rows > 1 && !eq_false(&repeat_header) {
        for row in 1..=header_rows {
            let _ = super::item(&table.member("Rows")?, row).and_then(|found| found.set_member("HeadingFormat", Com::Bool(true)));
        }
    }
    // The last row is the total when totalRow is set: bold over a rule.
    if eq_true(&prop(&props, "totalRow")) && rows > 1 {
        let total = super::item(&table.member("Rows")?, rows)?;
        total.member("Range")?.member("Font")?.set_member("Bold", Com::I4(-1))?;
        let rule = super::item(&total.member("Borders")?, -1)?;
        rule.set_member("LineStyle", Com::I4(1))?;
        rule.set_member("LineWidth", Com::I4(8))?;
        rule.set_member("Color", Com::I4(convert::color_value("374151").map_err(Error::host)?))?;
    }
    // One row's own type (rowStyles[row]: fontSize, color, bold) over the table's, with the row's exact line pitch following
    // its size.
    if truthy(&prop(&props, "rowStyles")) {
        let row_styles = pipeline_items(&prop(&props, "rowStyles"));
        for row in 1..=rows.min(row_styles.len() as i32) {
            let style = &row_styles[(row - 1) as usize];
            if style.is_null() {
                continue;
            }
            let row_range = super::item(&table.member("Rows")?, row)?.member("Range")?;
            if truthy(&prop(style, "fontSize")) {
                row_range.member("Font")?.set_member("Size", r4(&prop(style, "fontSize"))?)?;
                row_range.member("ParagraphFormat")?.set_member("LineSpacingRule", Com::I4(4))?;
                row_range.member("ParagraphFormat")?.set_member("LineSpacing", line_pitch(cast_single(&prop(style, "fontSize"))?))?;
            }
            if truthy(&prop(style, "color")) {
                row_range.member("Font")?.set_member("Color", color_of(&prop(style, "color"))?)?;
            }
            if !prop(style, "bold").is_null() {
                row_range.member("Font")?.set_member("Bold", flag(&prop(style, "bold"), -1))?;
            }
        }
    }
    let table_index = super::int(&table.member("Index")?)?;
    let mut pairs = vec![
        ("op", Value::string("add_table")),
        ("changed", Value::Bool(true)),
        ("table", Value::Int(table_index)),
        ("rows", Value::Int(rows)),
        ("columns", Value::Int(columns)),
    ];
    if !style_not_found.is_empty() {
        pairs.push(("styleNotFound", Value::String(style_not_found.join(", "))));
    }
    Ok(ordered(pairs))
}

/// `set_table_cell`.
pub(super) fn set_table_cell(document: &Obj, op: &Value) -> Result<Value> {
    let table = table_at(document, &prop(op, "table"))?;
    let row = cast_int(&prop(op, "row"))?;
    if row < 1 || row > super::count_of_collection(&table.member("Rows")?)? {
        return Err(Error::host(missing_row_message(&table, &prop(op, "table"), cast_int(&prop(op, "row"))?, "set_table_cell")?));
    }
    let cell = table_cell(&table, cast_int(&prop(op, "row"))?, cast_int(&prop(op, "col"))?)?;
    cell.member("Range")?.set_member("Text", Com::from(text_of(&prop(op, "text"))))?;
    Ok(ordered(vec![("op", Value::string("set_table_cell")), ("changed", Value::Bool(true))]))
}

/// `set_table_style`.
pub(super) fn set_table_style(document: &Obj, op: &Value) -> Result<Value> {
    let table = super::item(&document.get("Tables")?, cast_int(&prop(op, "table"))?)?;
    let props = prop(op, "properties");
    let style_not_found = if truthy(&prop(&props, "style")) { formatting::set_style(&table, &text_of(&prop(&props, "style"))) } else { None };
    if truthy(&prop(&props, "alignment")) {
        table.member("Rows")?.set_member("Alignment", Com::I4(table_alignment(&prop(&props, "alignment"))))?;
    }
    if truthy(&prop(&props, "columnAlignments")) {
        set_column_alignments(&table, &prop(&props, "columnAlignments"))?;
    }
    if truthy(&prop(&props, "columnWidths")) {
        let widths = pipeline_items(&prop(&props, "columnWidths"));
        let mut column = 1;
        // The bound is read from the table at every step, as the script's loop condition reads it.
        while column <= super::count_of_collection(&table.member("Columns")?)?.min(widths.len() as i32) {
            super::item(&table.member("Columns")?, column)?.set_member("Width", r4(&widths[(column - 1) as usize])?)?;
            column += 1;
        }
    }
    if truthy(&prop(&props, "borders")) {
        set_borders(&table, &prop(&props, "borders"))?;
    }
    if truthy(&prop(&props, "shading")) {
        table.member("Shading")?.set_member("BackgroundPatternColor", color_of(&prop(&props, "shading"))?)?;
    }
    let mut pairs = vec![("op", Value::string("set_table_style")), ("changed", Value::Bool(true)), ("table", Value::Int(cast_int(&prop(op, "table"))?))];
    if let Some(missing) = style_not_found {
        pairs.push(("styleNotFound", Value::String(missing)));
    }
    Ok(ordered(pairs))
}

/// `merge_table_cells`.
pub(super) fn merge_table_cells(document: &Obj, op: &Value) -> Result<Value> {
    let table = super::item(&document.get("Tables")?, cast_int(&prop(op, "table"))?)?;
    let span = |name: &str| -> Result<i32> { Ok(1_i32.max(if truthy(&prop(op, name)) { cast_int(&prop(op, name))? } else { 1 })) };
    let row_span = span("rowSpan")?;
    let col_span = span("colSpan")?;
    let last_row = cast_int(&prop(op, "row"))? + row_span - 1;
    let last_col = cast_int(&prop(op, "col"))? + col_span - 1;
    let first = table_cell(&table, cast_int(&prop(op, "row"))?, cast_int(&prop(op, "col"))?)?;
    let last = table_cell(&table, last_row, last_col)?;
    first.call_member("Merge", &[last])?;
    Ok(ordered(vec![
        ("op", Value::string("merge_table_cells")),
        ("changed", Value::Bool(true)),
        ("table", Value::Int(cast_int(&prop(op, "table"))?)),
        ("row", Value::Int(cast_int(&prop(op, "row"))?)),
        ("col", Value::Int(cast_int(&prop(op, "col"))?)),
    ]))
}

/// `set_table_cell_style`.
pub(super) fn set_table_cell_style(document: &Obj, op: &Value) -> Result<Value> {
    let table = super::item(&document.get("Tables")?, cast_int(&prop(op, "table"))?)?;
    let cell = table_cell(&table, cast_int(&prop(op, "row"))?, cast_int(&prop(op, "col"))?)?;
    let props = prop(op, "properties");
    let fill = prop(&props, "fillColor");
    let names_fill = matches!(&props, Value::Object(object) if object.get("fillColor").is_some());
    // null takes the shading away (wdColorAutomatic), as the portable writer writes an automatic fill.
    if names_fill && fill.is_null() {
        cell.member("Shading")?.set_member("BackgroundPatternColor", Com::I4(-16_777_216))?;
    } else if truthy(&fill) {
        cell.member("Shading")?.set_member("BackgroundPatternColor", color_of(&fill)?)?;
    }
    if truthy(&prop(&props, "verticalAlignment")) {
        let code = match lower(&text_of(&prop(&props, "verticalAlignment"))).as_str() {
            "center" | "middle" => 1,
            "bottom" => 3,
            _ => 0,
        };
        cell.set_member("VerticalAlignment", Com::I4(code))?;
    }
    if truthy(&prop(&props, "width")) {
        cell.set_member("Width", r4(&prop(&props, "width"))?)?;
    }
    if !prop(&props, "bold").is_null() {
        cell.member("Range")?.member("Font")?.set_member("Bold", flag(&prop(&props, "bold"), -1))?;
    }
    if !prop(&props, "italic").is_null() {
        cell.member("Range")?.member("Font")?.set_member("Italic", flag(&prop(&props, "italic"), -1))?;
    }
    if truthy(&prop(&props, "fontName")) {
        formatting::set_latin_font(&cell.member("Range")?.member("Font")?, &text_of(&prop(&props, "fontName")))?;
    }
    if truthy(&prop(&props, "fontNameEastAsia")) {
        cell.member("Range")?.member("Font")?.set_member("NameFarEast", Com::from(text_of(&prop(&props, "fontNameEastAsia"))))?;
    }
    if truthy(&prop(&props, "fontSize")) {
        cell.member("Range")?.member("Font")?.set_member("Size", r4(&prop(&props, "fontSize"))?)?;
        // The line pitch follows the size, as add_table set it.
        cell.member("Range")?.member("ParagraphFormat")?.set_member("LineSpacingRule", Com::I4(4))?;
        cell.member("Range")?.member("ParagraphFormat")?.set_member("LineSpacing", line_pitch(cast_single(&prop(&props, "fontSize"))?))?;
    }
    if truthy(&prop(&props, "color")) {
        cell.member("Range")?.member("Font")?.set_member("Color", color_of(&prop(&props, "color"))?)?;
    }
    let horizontal = prop(&props, "horizontalAlignment");
    if truthy(&horizontal) {
        // The cell's horizontal alignment is its paragraphs' alignment.
        let code = formatting::line_alignment(&horizontal, "set_table_cell_style horizontalAlignment")?;
        cell.member("Range")?.member("ParagraphFormat")?.set_member("Alignment", Com::I4(code))?;
    }
    Ok(ordered(vec![
        ("op", Value::string("set_table_cell_style")),
        ("changed", Value::Bool(true)),
        ("table", Value::Int(cast_int(&prop(op, "table"))?)),
        ("row", Value::Int(cast_int(&prop(op, "row"))?)),
        ("col", Value::Int(cast_int(&prop(op, "col"))?)),
    ]))
}

/// `insert_table_row`: row is the position the new row takes, before the row there now, or at the end for one past the last.
pub(super) fn insert_table_row(document: &Obj, op: &Value) -> Result<Value> {
    let table = table_at(document, &prop(op, "table"))?;
    let row_count = super::count_of_collection(&table.member("Rows")?)?;
    let row = prop(op, "row");
    if !row.is_null() {
        let at = cast_int(&row)?;
        if at < 1 || cast_int(&row)? > row_count + 1 {
            return Err(Error::host(missing_row_message(&table, &prop(op, "table"), cast_int(&row)?, "insert_table_row")?));
        }
    }
    if !row.is_null() && cast_int(&row)? <= row_count {
        let rows = table.member("Rows")?;
        let before = super::item(&table.member("Rows")?, cast_int(&row)?)?;
        rows.call_member("Add", &[before])?;
    } else {
        table.member("Rows")?.call_member("Add", &[])?;
    }
    Ok(ordered(vec![("op", Value::string("insert_table_row")), ("changed", Value::Bool(true)), ("rows", answered(&table.member("Rows")?.member("Count")?)?)]))
}

/// `delete_table_row`.
pub(super) fn delete_table_row(document: &Obj, op: &Value) -> Result<Value> {
    let table = table_at(document, &prop(op, "table"))?;
    let row = cast_int(&prop(op, "row"))?;
    if row < 1 || cast_int(&prop(op, "row"))? > super::count_of_collection(&table.member("Rows")?)? {
        return Err(Error::host(missing_row_message(&table, &prop(op, "table"), cast_int(&prop(op, "row"))?, "delete_table_row")?));
    }
    super::item(&table.member("Rows")?, cast_int(&prop(op, "row"))?)?.call_member("Delete", &[])?;
    Ok(ordered(vec![("op", Value::string("delete_table_row")), ("changed", Value::Bool(true)), ("rows", answered(&table.member("Rows")?.member("Count")?)?)]))
}

/// `insert_table_column`: column is the position the new column takes, before the column there now, or at the end for one
/// past the last.
pub(super) fn insert_table_column(document: &Obj, op: &Value) -> Result<Value> {
    let table = table_at(document, &prop(op, "table"))?;
    let column_count = super::count_of_collection(&table.member("Columns")?)?;
    let column = cast_int(&prop(op, "column"))?;
    if column < 1 || cast_int(&prop(op, "column"))? > column_count + 1 {
        return Err(Error::host(missing_column_message(&table, &prop(op, "table"), cast_int(&prop(op, "column"))?, "insert_table_column")?));
    }
    if cast_int(&prop(op, "column"))? <= column_count {
        let columns = table.member("Columns")?;
        let before = super::item(&table.member("Columns")?, cast_int(&prop(op, "column"))?)?;
        columns.call_member("Add", &[before])?;
    } else {
        table.member("Columns")?.call_member("Add", &[])?;
    }
    Ok(ordered(vec![
        ("op", Value::string("insert_table_column")),
        ("changed", Value::Bool(true)),
        ("columns", answered(&table.member("Columns")?.member("Count")?)?),
    ]))
}

/// `delete_table_column`.
pub(super) fn delete_table_column(document: &Obj, op: &Value) -> Result<Value> {
    let table = table_at(document, &prop(op, "table"))?;
    let column = cast_int(&prop(op, "column"))?;
    if column < 1 || cast_int(&prop(op, "column"))? > super::count_of_collection(&table.member("Columns")?)? {
        return Err(Error::host(missing_column_message(&table, &prop(op, "table"), cast_int(&prop(op, "column"))?, "delete_table_column")?));
    }
    super::item(&table.member("Columns")?, cast_int(&prop(op, "column"))?)?.call_member("Delete", &[])?;
    Ok(ordered(vec![
        ("op", Value::string("delete_table_column")),
        ("changed", Value::Bool(true)),
        ("columns", answered(&table.member("Columns")?.member("Count")?)?),
    ]))
}

/// `fit_table`.
pub(super) fn fit_table(document: &Obj, op: &Value) -> Result<Value> {
    let table = super::item(&document.get("Tables")?, cast_int(&prop(op, "table"))?)?;
    table.call_member("AutoFitBehavior", &[Com::I4(2)])?;
    Ok(ordered(vec![("op", Value::string("fit_table")), ("changed", Value::Bool(true)), ("table", Value::Int(cast_int(&prop(op, "table"))?))]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_border_size_snaps_up_to_the_next_line_width() {
        for (size, width) in [(0, 2), (2, 2), (3, 4), (4, 4), (5, 6), (8, 8), (9, 12), (13, 18), (24, 24), (25, 36), (37, 48), (100, 48)] {
            assert_eq!(line_width_for(size), width, "{size}");
        }
    }

    #[test]
    fn false_and_true_compare_the_way_powershell_compares_them() {
        assert!(eq_false(&Value::Bool(false)) && eq_false(&Value::Int(0)) && eq_false(&Value::string("false")));
        assert!(!eq_false(&Value::Null) && !eq_false(&Value::Bool(true)) && !eq_false(&Value::string("")));
        assert!(eq_true(&Value::Bool(true)) && eq_true(&Value::Int(1)) && eq_true(&Value::string("TRUE")));
        assert!(!eq_true(&Value::Int(2)) && !eq_true(&Value::Null));
    }

    #[test]
    fn the_line_pitch_is_a_double_of_one_point_three_times_the_size() {
        assert_eq!(line_pitch(11.0), Com::R8(f64::from(11.0_f32) * 1.3));
    }
}
