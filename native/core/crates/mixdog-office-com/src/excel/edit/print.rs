//! Print and fit: `Excel-ContentPrintArea`, `Set-ExcelSheetOnePageWide`, `autofit_range`, `set_page_setup`, `set_header_footer`.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::excel::cells::attempt;
use crate::excel::cells::double_of;
use crate::excel::cells::get_with;
use crate::excel::cells::is_null_or_dbnull;
use crate::excel::cells::is_ps_null;
use crate::excel::cells::items_of;
use crate::excel::cells::matrix_value;
use crate::excel::cells::ps_of;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::text;

use super::cell_at;
use super::com_text;
use super::double_cast;
use super::equals_bool;
use super::flag;
use super::int_cast;
use super::int_of_com;
use super::is_blank;
use super::is_match;
use super::present;
use super::prop;
use super::quiet;
use super::range_of;
use super::record_of;
use super::sheets::excel_sheet;
use super::string_of_com;
use super::text_of;

/// The longest a column may be made, in characters, and the shortest when no floor is asked for.
const COLUMN_CEILING: f64 = 80.0;
const COLUMN_FLOOR: f64 = 8.0;

/// `Excel-ContentPrintArea`: the used range grown to hold every drawing on the sheet, as an absolute address.
fn content_print_area(sheet: &Com) -> Result<String> {
    let used = sheet.member("UsedRange")?;
    let mut first_row = int_of_com(&used.member("Row")?)?;
    let mut first_column = int_of_com(&used.member("Column")?)?;
    let mut last_row = first_row + int_of_com(&used.member("Rows")?.member("Count")?)? - 1;
    let mut last_column = first_column + int_of_com(&used.member("Columns")?.member("Count")?)? - 1;
    let shapes = sheet.member("Shapes")?;
    let mut index = 1;
    while index <= int_of_com(&shapes.member("Count")?)? {
        let shape = get_with(&shapes, "Item", &[Com::I4(index)])?;
        let top_left = shape.member("TopLeftCell")?;
        let bottom_right = shape.member("BottomRightCell")?;
        first_row = first_row.min(int_of_com(&top_left.member("Row")?)?);
        first_column = first_column.min(int_of_com(&top_left.member("Column")?)?);
        last_row = last_row.max(int_of_com(&bottom_right.member("Row")?)?);
        last_column = last_column.max(int_of_com(&bottom_right.member("Column")?)?);
        index += 1;
    }
    let start = get_with(&sheet.member("Cells")?, "Item", &[Com::I4(first_row), Com::I4(first_column)])?;
    let end = get_with(&sheet.member("Cells")?, "Item", &[Com::I4(last_row), Com::I4(last_column)])?;
    let area = get_with(sheet, "Range", &[start, end])?;
    Ok(string_of_com(&get_with(&area, "Address", &[Com::Bool(true), Com::Bool(true), Com::I4(1)])?))
}

/// `Set-ExcelSheetOnePageWide`: a chart or picture beside a table is wider than a portrait page. A sheet that declares no fit,
/// print scale, or print area takes one page wide and keeps paging down (a fit only scales down, so a small sheet prints as
/// before); a declared setup is the author's and stays. Answers the fit applied. `PageSetup` needs a printer driver: without one
/// the sheet is left as it is.
pub(super) fn set_one_page_wide(sheet: &Com) -> Option<&'static str> {
    attempt(|| -> Result<Option<&'static str>> {
        let setup = sheet.member("PageSetup")?;
        if equals_bool(&ps_of(&setup.member("Zoom")?), false) {
            return Ok(None);
        }
        if int_of_com(&setup.member("Zoom")?)? != 100 {
            return Ok(None);
        }
        if !is_blank(&string_of_com(&setup.member("PrintArea")?)) {
            return Ok(None);
        }
        setup.set_member("Zoom", Com::Bool(false))?;
        setup.set_member("FitToPagesWide", Com::I4(1))?;
        setup.set_member("FitToPagesTall", Com::Bool(false))?;
        Ok(Some("one-page-wide"))
    })
    .flatten()
}

/// `$cell.WrapText -eq $true`.
fn wraps(cell: &Com) -> Result<bool> {
    Ok(equals_bool(&ps_of(&cell.member("WrapText")?), true))
}

/// The cells of the measured range that are wrapped. WrapText answers for the whole range at once: true, false, or DBNull when
/// the cells differ; then it is asked row by row, and only a mixed row is walked.
fn wrapped_cells(measured: &Com, wrap_all: &Com) -> Result<Vec<Com>> {
    if matches!(wrap_all, Com::Bool(true)) {
        return items_of(measured);
    }
    let mut wrapped = Vec::new();
    if !matches!(wrap_all, Com::Bool(_)) {
        for line in items_of(&measured.member("Rows")?)? {
            match line.member("WrapText")? {
                Com::Bool(true) => wrapped.push(line),
                Com::Bool(false) => {}
                _ => {
                    for cell in items_of(&line.member("Cells")?)? {
                        if wraps(&cell)? {
                            wrapped.push(cell);
                        }
                    }
                }
            }
        }
    }
    Ok(wrapped)
}

/// The cells of the range that are the only text of their row: such a line (a title, the instruction under it) prints across
/// the empty cells beside it, so a fit over several columns does not size its column to it. The used range is read once as
/// values, so a long sheet costs no call per row.
fn spilling_cells(book: &Com, sheet: &Com, target: &Com) -> Result<Vec<Com>> {
    let mut spilling = Vec::new();
    let used = sheet.member("UsedRange")?;
    let grid = used.member("Value2")?;
    // The formula text says a cell is filled even where its result is empty ("" from an IF): a label beside such a row is a row
    // label, as the portable writer reads it.
    let source = used.member("Formula")?;
    let (Com::Array(grid_array), Com::Array(_)) = (&grid, &source) else { return Ok(spilling) };
    if grid_array.rank() != 2 {
        return Err(Error::host("Exception calling \"GetLength\" with \"1\" argument(s): \"Index was outside the bounds of the array.\""));
    }
    let grid_rows = grid_array.dims()[0].len as i32;
    let grid_columns = grid_array.dims()[1].len as i32;
    for r in 1..=grid_rows {
        let mut hits = 0;
        let mut at = 0;
        for c in 1..=grid_columns {
            let entry = matrix_value(&source, r, c);
            if !is_ps_null(&entry) && !string_of_com(&entry).trim().is_empty() {
                hits += 1;
                at = c;
                if hits > 1 {
                    break;
                }
            }
        }
        if hits != 1 {
            continue;
        }
        if !matches!(matrix_value(&grid, r, at), Com::Str(_)) || string_of_com(&matrix_value(&source, r, at)).starts_with('=') {
            continue;
        }
        let cell = cell_at(&used, r, at)?;
        if wraps(&cell)? {
            continue;
        }
        let overlap = book.member("Application")?.call_member("Intersect", &[cell.clone(), target.clone()])?;
        if is_null_or_dbnull(&overlap) {
            continue;
        }
        spilling.push(cell);
    }
    Ok(spilling)
}

/// `autofit_range`: the columns fit the cells of the range only, as the portable writer measures them (fitting the entire
/// columns sized a report's table column to the long subtitle above it), then its rule: two characters of air past the text, a
/// floor of 8 (`minWidth` when a composed layout asks for one) and a ceiling of 80. A column with nothing in the range keeps its
/// width unless a floor was asked for. A row fit names rows (1:12): fitting columns there would rewrite widths the caller never
/// asked about, so only a range naming columns fits them.
pub(super) fn autofit_range(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let target = range_of(&sheet, &text_of(op, "range"))?;
    let rows_wanted = flag(op, "rows");
    let rows_only = rows_wanted && is_match(&text_of(op, "range"), r"^\s*\d+\s*:\s*\d+\s*$")?;
    if !rows_only {
        fit_columns(book, op, &sheet, &target)?;
    }
    if rows_wanted {
        // Excel fits a row holding a merged cell to one line of default height: the composed sheet's title band, set two lines
        // tall, came back cut. Those rows keep the height they were given, as the portable writer keeps every row's.
        let application = book.member("Application")?;
        let entire = target.member("EntireRow")?;
        let in_use = application.call_member("Intersect", &[entire, sheet.member("UsedRange")?])?;
        if !is_null_or_dbnull(&in_use) {
            for line in items_of(&in_use.member("Rows")?)? {
                if !equals_bool(&ps_of(&line.member("MergeCells")?), false) {
                    continue;
                }
                line.member("EntireRow")?.call_member("AutoFit", &[])?;
            }
        }
    }
    Ok(record_of("autofit_range", true, vec![("range", Value::String(text_of(op, "range")))]))
}

fn fit_columns(book: &Com, op: &Value, sheet: &Com, target: &Com) -> Result<()> {
    // A wrapped cell counts at its full line, as the portable writer measures it (up to the 80 ceiling): Excel's own fit skips it,
    // and a note column came back ten characters wide and three lines deep where the portable file set it on one line.
    let application = book.member("Application")?;
    let measured = application.call_member("Intersect", &[target.clone(), sheet.member("UsedRange")?])?;
    let has_measured = !is_null_or_dbnull(&measured);
    let wrap_all = if has_measured { measured.member("WrapText")? } else { Com::Bool(false) };
    let wrapped = wrapped_cells(&measured, &wrap_all)?;
    let mut spilling = Vec::new();
    if int_of_com(&target.member("Columns")?.member("Count")?)? > 1 && has_measured {
        spilling = spilling_cells(book, sheet, target)?;
    }
    for cell in &wrapped {
        cell.set_member("WrapText", Com::Bool(false))?;
    }
    for cell in &spilling {
        cell.set_member("WrapText", Com::Bool(true))?;
    }
    target.member("Columns")?.call_member("AutoFit", &[])?;
    for cell in &spilling {
        cell.set_member("WrapText", Com::Bool(false))?;
    }
    for cell in &wrapped {
        cell.set_member("WrapText", Com::Bool(true))?;
    }
    let floored = present(op, "minWidth") && double_cast(&prop(op, "minWidth"))? > 0.0;
    let floor = if floored { COLUMN_CEILING.min(double_cast(&prop(op, "minWidth"))?) } else { COLUMN_FLOOR };
    for column in items_of(&target.member("Columns")?)? {
        if !floored {
            let counted = book.member("Application")?.member("WorksheetFunction")?.call_member("CountA", &[column.clone()])?;
            if double_of(&counted)? == 0.0 {
                continue;
            }
        }
        let width = double_of(&column.member("ColumnWidth")?)? + 2.0;
        column.set_member("ColumnWidth", Com::R4(COLUMN_CEILING.min(floor.max(width)) as f32))?;
    }
    Ok(())
}

/// `set_page_setup`. Every page setting is a round trip through the printer driver: a composed dashboard's margins, fit, and
/// centring took 1.3 s. With PrintCommunication held off Excel takes them together when it comes back on; the answer is read
/// after that.
pub(super) fn set_page_setup(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let setup = sheet.member("PageSetup")?;
    let application = book.member("Application")?;
    let held = application.set_member("PrintCommunication", Com::Bool(false)).is_ok();
    let applied = apply_page_setup(book, op, &sheet, &setup);
    if held {
        quiet(|| application.set_member("PrintCommunication", Com::Bool(true)));
    }
    applied?;
    Ok(record_of(
        "set_page_setup",
        true,
        vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?))), ("printArea", Value::String(string_of_com(&setup.member("PrintArea")?)))],
    ))
}

fn apply_page_setup(book: &Com, op: &Value, sheet: &Com, setup: &Com) -> Result<()> {
    if flag(op, "fitToContent") {
        setup.set_member("PrintArea", com_text(content_print_area(sheet)?))?;
    } else if flag(op, "printArea") {
        setup.set_member("PrintArea", com_text(text_of(op, "printArea")))?;
    }
    if flag(op, "orientation") {
        let landscape = convert::equals(&Value::String(text_of(op, "orientation")), &Value::string("landscape"));
        setup.set_member("Orientation", Com::I4(if landscape { 2 } else { 1 }))?;
    }
    // A fit bounds the pages it names and leaves the other side free, as the portable writer writes it: left untouched, Excel kept
    // the other count at 1 and fitToPagesWide:1 shrank a 92-row log onto one page. Excel expects Variant False for "no page limit";
    // the integer 0 throws. A count and False are set from separate statements.
    if present(op, "fitToPagesWide") || present(op, "fitToPagesTall") {
        setup.set_member("Zoom", Com::Bool(false))?;
        for (key, member) in [("fitToPagesWide", "FitToPagesWide"), ("fitToPagesTall", "FitToPagesTall")] {
            let pages = int_cast(&prop(op, key))?;
            if pages > 0 {
                setup.set_member(member, Com::I4(pages))?;
            } else {
                setup.set_member(member, Com::Bool(false))?;
            }
        }
    }
    if present(op, "centerHorizontally") {
        setup.set_member("CenterHorizontally", Com::Bool(flag(op, "centerHorizontally")))?;
    }
    if present(op, "centerVertically") {
        setup.set_member("CenterVertically", Com::Bool(flag(op, "centerVertically")))?;
    }
    // Margins are inches, as the portable writer's pageMargins and Excel's Page Setup read them; Excel's object model takes points.
    for (key, member) in [("topMargin", "TopMargin"), ("bottomMargin", "BottomMargin"), ("leftMargin", "LeftMargin"), ("rightMargin", "RightMargin")] {
        if present(op, key) {
            let inches = double_cast(&prop(op, key))?;
            let points = book.member("Application")?.call_member("InchesToPoints", &[Com::R8(inches)])?;
            setup.set_member(member, points)?;
        }
    }
    // The header rows every printed page repeats, as the portable writer's Print_Titles.
    if present(op, "printTitleRows") && !text_of(op, "printTitleRows").trim().is_empty() {
        let given = text_of(op, "printTitleRows");
        let span: Vec<String> = given.replace('$', "").split(':').map(str::to_owned).collect();
        let first = int_cast(&Value::String(span[0].clone()))?;
        let last = if span.len() > 1 { int_cast(&Value::String(span[1].clone()))? } else { first };
        if first < 1 || last < first {
            return Err(Error::host(format!("set_page_setup printTitleRows is a row or a span of rows such as \"1\" or \"4:5\", not \"{given}\"")));
        }
        setup.set_member("PrintTitleRows", com_text(format!("${first}:${last}")))?;
    }
    Ok(())
}

/// `set_header_footer`: the same token vocabulary as the portable writer ({page} and {pages} and the rest become Excel field
/// codes), and the caller's own ampersand survives.
pub(super) fn set_header_footer(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let named = text::to_lower_invariant(&text_of(op, "kind"));
    if named != "header" && named != "footer" {
        return Err(Error::host("set_header_footer kind must be header or footer"));
    }
    let alignment = if flag(op, "alignment") { text::to_lower_invariant(&text_of(op, "alignment")) } else { "center".to_owned() };
    if !["left", "center", "right"].contains(&alignment.as_str()) {
        return Err(Error::host("set_header_footer alignment must be left, center, or right"));
    }
    // LeftHeader / CenterFooter and the rest: the slot and the story name it.
    let mut letters = alignment.chars();
    let slot: String = letters.next().map(|first| first.to_ascii_uppercase()).into_iter().chain(letters).collect();
    let property = format!("{slot}{}", if named == "header" { "Header" } else { "Footer" });
    let mut marked = text_of(op, "text").replace('&', "&&");
    for (token, code) in [(r"\{page\}", "&P"), (r"\{pages\}", "&N"), (r"\{date\}", "&D"), (r"\{time\}", "&T"), (r"\{sheet\}", "&A"), (r"\{file\}", "&F")] {
        marked = text::replace(&marked, token, code, false).map_err(Error::host)?;
    }
    sheet.member("PageSetup")?.set_member(&property, com_text(marked))?;
    Ok(record_of(
        "set_header_footer",
        true,
        vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?))), ("kind", Value::String(named)), ("alignment", Value::String(alignment))],
    ))
}
