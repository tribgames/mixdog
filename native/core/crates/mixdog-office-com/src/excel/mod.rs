//! Microsoft Excel through COM: the workbook reader (`Snapshot-Excel`, `Snapshot-ExcelPage`, `Snapshot-Selection`,
//! `Issues-Excel`) of `office-com-host.ps1`, registered as the `xlsx` [`FormatReader`].
//!
//! * [`cells`]: a COM value as the PowerShell value the host wrote, matrices, column letters, where a drawing sits on the grid.
//! * [`numfmt`]: number formats in the words of the file (the colour names of the UI language).
//! * [`styles`]: a cell's style, a block's shared style, the workbook's default style.
//! * [`validation`]: validation blocks and formula lineage.
//! * [`snapshot`]: the whole-workbook read; [`page`]: the paged read of one range.
//! * [`selection`] and [`issues`]: the user's selection, and the review's issues and the financial-model audit.
//! * [`edit`]: the editor.
//!
//! Every COM call is made in the order the script makes it, so a replay of a recorded call log matches.

pub(crate) mod cells;
pub mod edit;
mod issues;
pub(crate) mod numfmt;
mod page;
mod selection;
mod snapshot;
mod styles;
mod validation;

use crate::com::Obj;
use crate::com::Result;
use crate::format::FormatReader;
use crate::office::Env;
use crate::ps::Value;

/// The reader of workbooks.
pub struct Reader;

impl FormatReader for Reader {
    fn snapshot(&self, _env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value> {
        snapshot::snapshot_excel(document, payload)
    }

    fn snapshot_page(&self, _env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value> {
        page::snapshot_excel_page(document, payload)
    }

    fn issues(&self, env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value> {
        issues::issues_excel(env, document, payload)
    }

    fn selection(&self, _env: &Env<'_>, document: &Obj) -> Result<Value> {
        selection::snapshot_selection(document)
    }
}
