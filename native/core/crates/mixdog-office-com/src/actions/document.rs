//! What a document is made to do beyond reading and editing: `Save-DocumentCopy`, `Restore-ExcelCheckpoint`,
//! `Rollback-LiveDocument` and `Render-Document` of `office-com-host.ps1`. (`Save-Document` is [`crate::office::save_document`].)

use std::time::Duration;

use mixdog_fsio::WriteProof;

use super::Actions;
use super::null_call;
use super::text;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::office::save_format_for_path;

/// How long a rendered file is waited for.
const RENDER_WAIT: Duration = Duration::from_secs(30);

/// How long the wait pauses between looks.
const RENDER_POLL_MS: u32 = 150;

/// The PDF type of a workbook's export (`xlTypePDF`) and of a document's (`wdExportFormatPDF`).
const EXCEL_PDF: i32 = 0;
const WORD_PDF: i32 = 17;
/// `ppSaveAsPDF`.
const POWERPOINT_PDF: i32 = 32;

/// `$collection.Item($index)`: a parameterized property read; `$null` has no method to call.
pub(crate) fn item_with(collection: &Com, index: Com) -> Result<Com> {
    match collection.as_obj() {
        Some(collection) => collection.get_with("Item", &[index]),
        None => Err(null_call()),
    }
}

/// `@($collection)`: the items of a collection, or the one value that is not one.
pub(crate) fn items_of(value: &Com) -> Result<Vec<Com>> {
    match value.as_obj() {
        Some(collection) => collection.items(),
        None => Ok(vec![value.clone()]),
    }
}

/// `Save-DocumentCopy`: a workbook's `SaveCopyAs(path)` and a deck's `SaveCopyAs(path, format)`. Word has no copy command (`SaveAs2`
/// would move the document to the new file), so its document is saved where it is and that file is copied: the session stays on
/// its own target and a later edit and save land there.
pub fn save_document_copy(document: &Obj, format: &str, output: &str) -> Result<()> {
    match format {
        "docx" => {
            document.call("Save", &[])?;
            let full_name = document.get("FullName")?;
            let source = full_name.as_str().ok_or_else(|| Error::host("The document has no file to copy".to_owned()))?;
            copy_saved_file(source, output)
        }
        "xlsx" => document.call("SaveCopyAs", &[Com::from(output)]).map(|_| ()),
        "pptx" => {
            let save_format = save_format_for_path(format, output).unwrap_or(24);
            document.call("SaveCopyAs", &[Com::from(output), Com::I4(save_format)]).map(|_| ())
        }
        other => Err(Error::host(format!("Save-copy is unsupported for .{other}"))),
    }
}

/// A saved document's file copied to `output`.
fn copy_saved_file(source: &str, output: &str) -> Result<()> {
    mixdog_fsio::copy(&mixdog_fsio::Unlaned, source, output)
        .map(|_| ())
        .map_err(|error| Error::host(format!("Save-copy of {source} to {output} failed: {error}")))
}

/// The sheets of a workbook put back from a checkpoint copy: the original sheets are replaced by the checkpoint's, so
/// every cell, name and chart is as it was when the copy was taken.
fn replace_sheets<P: WriteProof>(actions: &Actions<'_, P>, book: &Obj, app: &Com, checkpoint: &str, source: &mut Option<Com>) -> Result<()> {
    let opened = app.member("Workbooks")?.call_member("Open", &[Com::from(checkpoint), Com::Null, Com::Bool(true)])?;
    let opened = source.insert(opened);
    let original_sheets = items_of(&book.get("Worksheets")?)?;
    let temporary = book.get("Worksheets")?.call_member("Add", &[])?;
    let guid = actions.env.platform.new_guid_n();
    temporary.set_member("Name", Com::Str(format!("__MixdogRestore{}", &guid[..guid.len().min(8)])))?;
    for sheet in original_sheets {
        sheet.call_member("Delete", &[])?;
    }
    for sheet in items_of(&opened.member("Worksheets")?)? {
        let sheets = book.get("Worksheets")?;
        let last = book.get("Worksheets")?.member("Count")?;
        let last_sheet = item_with(&sheets, last)?;
        sheet.call_member("Copy", &[Com::Missing, last_sheet])?;
    }
    temporary.call_member("Delete", &[])?;
    book.put("Saved", Com::Bool(false))?;
    Ok(())
}

/// `Restore-ExcelCheckpoint`: with the application's alerts off (and put back as they were), the checkpoint opened
/// read-only, a temporary sheet so the workbook is never without one, every original sheet deleted, the checkpoint's
/// sheets copied after the last, the temporary one deleted, and the workbook marked edited.
pub fn restore_excel_checkpoint<P: WriteProof>(actions: &Actions<'_, P>, book: &Obj, checkpoint: &str) -> Result<()> {
    let app = book.get("Application")?;
    let alerts = app.member("DisplayAlerts")?;
    app.set_member("DisplayAlerts", Com::Bool(false))?;
    let mut source: Option<Com> = None;
    let outcome = replace_sheets(actions, book, &app, checkpoint, &mut source);
    if let Some(source) = &source {
        let _ = source.call_member("Close", &[Com::Bool(false)]);
    }
    app.set_member("DisplayAlerts", alerts)?;
    outcome
}

/// `Rollback-LiveDocument`: Word's undo stack, a workbook's checkpoint, or PowerPoint's Undo command, once per unit.
pub fn rollback_live_document<P: WriteProof>(actions: &Actions<'_, P>, document: &Obj, format: &str, checkpoint: &str, undo_units: i32) -> Result<()> {
    match format {
        "docx" => {
            if undo_units > 0 {
                document.call("Undo", &[Com::I4(undo_units)])?;
            }
            Ok(())
        }
        "xlsx" => restore_excel_checkpoint(actions, document, checkpoint),
        "pptx" => {
            for _ in 0..undo_units {
                document.get("Application")?.member("CommandBars")?.call_member("ExecuteMso", &[Com::from("Undo")])?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// What a sheet's page setup was before the render changed it.
struct PageSetupBefore {
    page_setup: Com,
    zoom: Com,
    fit_wide: Com,
    fit_tall: Com,
}

/// `$pageSetup.Zoom -eq $false`: a sheet that declares a fit has no zoom.
fn zoom_is_off(zoom: &Com) -> bool {
    match zoom {
        Com::Bool(flag) => !*flag,
        other => other.as_i64() == Some(0),
    }
}

/// One sheet previewed one page wide, when it has no fit of its own (a sheet that declares a fit prints by it, and the
/// review shows that print); its page setup is kept in `states` to be put back.
fn fit_sheet_to_one_page_wide(sheet: &Com, states: &mut Vec<PageSetupBefore>) -> Result<()> {
    let page_setup = sheet.member("PageSetup")?;
    if zoom_is_off(&page_setup.member("Zoom")?) {
        return Ok(());
    }
    let before = PageSetupBefore {
        page_setup: page_setup.clone(),
        zoom: page_setup.member("Zoom")?,
        fit_wide: page_setup.member("FitToPagesWide")?,
        fit_tall: page_setup.member("FitToPagesTall")?,
    };
    states.push(before);
    page_setup.set_member("Zoom", Com::Bool(false))?;
    page_setup.set_member("FitToPagesWide", Com::I4(1))?;
    page_setup.set_member("FitToPagesTall", Com::Bool(false))
}

fn export_workbook(document: &Obj, output: &str, states: &mut Vec<PageSetupBefore>) -> Result<()> {
    for sheet in items_of(&document.get("Worksheets")?)? {
        let _ = fit_sheet_to_one_page_wide(&sheet, states);
    }
    document.call("ExportAsFixedFormat", &[Com::I4(EXCEL_PDF), Com::from(output)]).map(|_| ())
}

fn restore_page_setups(states: Vec<PageSetupBefore>) {
    for before in states {
        let restore = || -> Result<()> {
            before.page_setup.set_member("Zoom", before.zoom.clone())?;
            before.page_setup.set_member("FitToPagesWide", before.fit_wide.clone())?;
            before.page_setup.set_member("FitToPagesTall", before.fit_tall.clone())
        };
        let _ = restore();
    }
}

/// `Render-Document`: the PDF export of the format, then the wait for the file. PowerPoint honours only the first
/// `SaveCopyAs` PDF export per open presentation and silently ignores later ones, so a session host reopens the deck
/// before every repeat export.
pub fn render_document<P: WriteProof>(actions: &Actions<'_, P>, document: &Obj, format: &str, output: &str) -> std::result::Result<(), String> {
    match format {
        "docx" => {
            document.call("ExportAsFixedFormat", &[Com::from(output), Com::I4(WORD_PDF)]).map_err(text)?;
        }
        "xlsx" => {
            let mut states = Vec::new();
            let exported = export_workbook(document, output, &mut states);
            restore_page_setups(states);
            exported.map_err(text)?;
        }
        "pptx" => {
            document.call("SaveCopyAs", &[Com::from(output), Com::I4(POWERPOINT_PDF)]).map_err(text)?;
        }
        _ => {}
    }
    wait_for_file(actions, output)
}

/// `SaveCopyAs` can return before the PDF is on disk: waits for the file to exist with a stable, non-zero size.
fn wait_for_file<P: WriteProof>(actions: &Actions<'_, P>, output: &str) -> std::result::Result<(), String> {
    let platform = actions.env.platform;
    let deadline = platform.now() + RENDER_WAIT;
    let mut last_size: i64 = -1;
    while platform.now() < deadline {
        if actions.exists(output) {
            let length = mixdog_fsio::metadata(actions.proof, output).map_err(|error| error.to_string())?.len();
            let size = i64::try_from(length).unwrap_or(i64::MAX);
            if size > 0 && size == last_size {
                return Ok(());
            }
            last_size = size;
        }
        platform.sleep(RENDER_POLL_MS);
    }
    Err(format!("Rendered PDF did not appear at {output} within 30 seconds."))
}
