//! Microsoft Excel through COM: the workbook reader (`Snapshot-Excel`, `Snapshot-Selection`,
//! `Issues-Excel`) of `office-com-host.ps1`, registered as the `xlsx` [`FormatReader`].
//!
//! Every COM call is made in the order the script makes it, so a replay of a recorded call log matches.

pub(crate) mod cells;
pub mod edit;
mod issues;
pub(crate) mod numfmt;
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

    fn issues(&self, env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value> {
        issues::issues_excel(env, document, payload)
    }

    fn selection(&self, _env: &Env<'_>, document: &Obj) -> Result<Value> {
        selection::snapshot_selection(document)
    }
}
