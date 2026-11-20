//! The sheet's window: `Activate-ExcelSheetWindow`, `freeze_panes`, `set_sheet_view`.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::excel::cells::attempt;
use crate::excel::cells::bool_of;
use crate::excel::cells::double_of;
use crate::excel::cells::get_with;
use crate::excel::cells::int_of;
use crate::excel::cells::ps_of;
use crate::office::Env;
use crate::ps::Value;
use crate::ps::convert;

use super::int_cast;
use super::present;
use super::prop;
use super::quiet;
use super::record_of;
use super::sheets::excel_sheet;
use super::string_of_com;

/// How many times the hidden view window is hidden again, and the pause between the attempts.
const HIDE_ATTEMPTS: u32 = 20;
const HIDE_PAUSE_MS: u32 = 25;

/// `Activate-ExcelSheetWindow`: the sheet's window, the sheet activated. In a hidden application the window the activation
/// shows is hidden again.
fn activate_sheet_window(env: &Env<'_>, book: &Com, sheet: &Com) -> Result<Com> {
    let application = book.member("Application")?;
    let app_visible = bool_of(&application.member("Visible")?);
    let window = get_with(&book.member("Windows")?, "Item", &[Com::I4(1)])?;
    if app_visible {
        book.call_member("Activate", &[])?;
        window.call_member("Activate", &[])?;
        sheet.call_member("Activate", &[])?;
        return Ok(window);
    }
    quiet(|| book.member("Application")?.set_member("ScreenUpdating", Com::Bool(false)));
    quiet(|| sheet.call_member("Activate", &[]));
    let hwnd = attempt(|| {
        let value = book.member("Application")?.member("Hwnd")?;
        convert::to_int64(&ps_of(&value)).map_err(Error::host)
    })
    .unwrap_or(0);
    if hwnd != 0 {
        let platform = env.platform;
        let _ = platform.hide_window(hwnd);
        let mut tries = 0;
        while tries < HIDE_ATTEMPTS && platform.window_visible(hwnd) {
            platform.sleep(HIDE_PAUSE_MS);
            let _ = platform.hide_window(hwnd);
            tries += 1;
        }
        if platform.window_visible(hwnd) {
            return Err(Error::host("Background Excel view window remained visible after sheet activation."));
        }
    }
    Ok(window)
}

/// `$window.Name = [double]$value`, ignoring a refusal.
fn put_quiet(window: &Com, name: &str, value: Com) {
    quiet(|| window.set_member(name, value));
}

/// `freeze_panes`: `row` and `column` name the first row and column that scroll, as the portable writer reads them (row:2
/// freezes the header in row 1).
pub(super) fn freeze_panes(env: &Env<'_>, book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let window = activate_sheet_window(env, book, &sheet)?;
    quiet(|| {
        if int_of(&window.member("View")?)? != 1 {
            window.set_member("View", Com::I4(1))?;
        }
        Ok(())
    });
    let split_row = (if present(op, "row") { int_cast(&prop(op, "row"))? } else { 0 } - 1).max(0);
    let split_column = (if present(op, "column") { int_cast(&prop(op, "column"))? } else { 0 } - 1).max(0);
    window.set_member("FreezePanes", Com::Bool(false))?;
    window.set_member("SplitRow", Com::I4(0))?;
    window.set_member("SplitColumn", Com::I4(0))?;
    if split_row > 0 || split_column > 0 {
        split_panes(book, &sheet, &window, split_row, split_column)?;
    }
    Ok(record_of("freeze_panes", true, Vec::new()))
}

/// The split of `freeze_panes`. Excel splits only at a row and column on screen, and a hidden background window shows about ten
/// rows at 100%: a report whose header sits in row 12 froze at row 11. The split is made zoomed out, and the sheet's own zoom
/// comes back once the panes are frozen. The screen updates meanwhile (the application stays hidden): with updating off, the zoom
/// never reaches the layout the split is measured against.
fn split_panes(book: &Com, sheet: &Com, window: &Com, split_row: i32, split_column: i32) -> Result<()> {
    window.set_member("ScrollRow", Com::I4(1))?;
    window.set_member("ScrollColumn", Com::I4(1))?;
    let zoom = attempt(|| window.member("Zoom"));
    let updating = attempt(|| Ok(bool_of(&book.member("Application")?.member("ScreenUpdating")?))).unwrap_or(true);
    quiet(|| book.member("Application")?.set_member("ScreenUpdating", Com::Bool(true)));
    // A workbook opened in the background can come up in a window a few rows high (114 x 58 pt), too short to split even zoomed
    // out. The window is made big enough for the split and given its size back after (it is saved).
    let frame = attempt(|| Ok((double_of(&window.member("Width")?)?, double_of(&window.member("Height")?)?)));
    if let Some((width, height)) = frame {
        if width < 400.0 || height < 300.0 {
            quiet(|| {
                window.set_member("Width", Com::R8(800.0))?;
                window.set_member("Height", Com::R8(600.0))
            });
        }
    }
    // A Double, as `set_sheet_view` and the restore below set it: a hidden window refused an Int32 zoom.
    put_quiet(window, "Zoom", Com::R8(10.0));
    window.set_member("SplitRow", Com::I4(split_row))?;
    window.set_member("SplitColumn", Com::I4(split_column))?;
    let restore = |zoom: &Option<Com>| {
        if let Some(zoom) = zoom.as_ref().filter(|zoom| !matches!(zoom, Com::Empty | Com::Missing)) {
            if let Ok(number) = convert::to_double(&ps_of(zoom)) {
                put_quiet(window, "Zoom", Com::R8(number));
            }
        }
        if let Some((width, height)) = frame {
            quiet(|| {
                window.set_member("Width", Com::R8(width))?;
                window.set_member("Height", Com::R8(height))
            });
        }
        quiet(|| book.member("Application")?.set_member("ScreenUpdating", Com::Bool(updating)));
    };
    let frozen = (|| -> Result<(i32, i32)> {
        window.set_member("FreezePanes", Com::Bool(true))?;
        // Read while zoomed out: back at the sheet's zoom a small hidden window counts only the frozen rows it can show though the
        // panes stay frozen where they were made.
        let row = int_of(&window.member("SplitRow")?)?;
        let column = int_of(&window.member("SplitColumn")?)?;
        restore(&zoom);
        Ok((row, column))
    })();
    match frozen {
        Ok((row, column)) => {
            if row != split_row || column != split_column {
                return Err(Error::host(format!("Excel froze panes at row={row} column={column} instead of row={split_row} column={split_column}")));
            }
            Ok(())
        }
        Err(error) => {
            restore(&zoom);
            Err(freeze_refusal(book, sheet, window, split_row, split_column, &error)?)
        }
    }
}

/// The refusal of a freeze that failed, with what the window and the application looked like.
fn freeze_refusal(book: &Com, sheet: &Com, window: &Com, split_row: i32, split_column: i32, cause: &Error) -> Result<Error> {
    let boolean = |value: bool| if value { "True" } else { "False" };
    let active_sheet = attempt(|| Ok(string_of_com(&book.member("ActiveSheet")?.member("Name")?))).unwrap_or_default();
    let active_cell = attempt(|| {
        let cell = book.member("Application")?.member("ActiveCell")?;
        Ok(string_of_com(&get_with(&cell, "Address", &[Com::Bool(false), Com::Bool(false)])?))
    })
    .unwrap_or_default();
    let app_visible = attempt(|| Ok(bool_of(&book.member("Application")?.member("Visible")?))).unwrap_or(false);
    let window_visible = attempt(|| Ok(bool_of(&window.member("Visible")?))).unwrap_or(false);
    let view = attempt(|| int_of(&window.member("View")?)).unwrap_or(0);
    let window_state = attempt(|| int_of(&window.member("WindowState")?)).unwrap_or(0);
    let window_size =
        attempt(|| Ok(format!("{}x{}", int_of(&window.member("Width")?)?, int_of(&window.member("Height")?)?))).unwrap_or_else(|| "unknown".to_owned());
    let sheet_name = string_of_com(&sheet.member("Name")?);
    let split_row_now = int_of(&window.member("SplitRow")?)?;
    let split_column_now = int_of(&window.member("SplitColumn")?)?;
    Ok(Error::host(format!(
        "Cannot freeze panes on '{sheet_name}' at row={split_row} column={split_column}; activeSheet='{active_sheet}', activeCell='{active_cell}', appVisible={}, windowVisible={}, windowState={window_state}, windowSize={window_size}, view={view}, splitRow={split_row_now}, splitColumn={split_column_now}. {}",
        boolean(app_visible),
        boolean(window_visible),
        cause.message()
    )))
}

/// `set_sheet_view`: gridlines and zoom.
pub(super) fn set_sheet_view(env: &Env<'_>, book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let window = activate_sheet_window(env, book, &sheet)?;
    if present(op, "showGridlines") {
        window.set_member("DisplayGridlines", Com::Bool(convert::to_bool(&prop(op, "showGridlines"))))?;
    }
    // A double: a hidden window with frozen panes refuses an integer zoom ("Specified cast is not valid").
    if present(op, "zoom") {
        let zoom = int_cast(&prop(op, "zoom"))?.clamp(10, 400);
        window.set_member("Zoom", Com::R8(f64::from(zoom)))?;
    }
    Ok(record_of("set_sheet_view", true, vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?)))]))
}
