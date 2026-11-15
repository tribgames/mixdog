//! `portable/portable-snapshot.mjs`: the one entry that reads a portable OOXML file as the Office tool shows it to the model,
//! dispatching to the snapshot of its format. The three format snapshots and the helpers the other modules read live in
//! their own modules and are re-exported here under the names `portable-snapshot.mjs` exported them by.

use std::path::Path;

use mixdog_fsio::ReadProof;
use serde_json::Value;

use crate::package::load_package;
use crate::text_metrics::TextMeasurer;

pub use crate::snapshot_docx::{append_docx_block, docx_body_model, snapshot_docx};
pub use crate::snapshot_pptx::snapshot_pptx;
pub use crate::snapshot_xlsx::{FULL_READ_CELL_LIMIT, snapshot_xlsx};

/// `snapshotPortableOoxml(path, format, options)`: the snapshot of the package at `path` read as a `docx`, `xlsx` or `pptx`
/// file. The package is opened before the format is looked at, so an unreadable file is reported ahead of an unknown format.
/// `options` is the tool call's own (`paged`, `offset`, `limit`, `sheet`, `range`, `pages`, `full`, `target`).
pub fn snapshot_portable_ooxml<P: ReadProof>(proof: &P, measurer: &TextMeasurer<'_, P>, path: &Path, format: &str, options: &Value) -> Result<Value, String> {
    let zip = load_package(proof, path)?;
    match format {
        "docx" => Ok(snapshot_docx(&zip, options)),
        "xlsx" => snapshot_xlsx(measurer, &zip, options),
        "pptx" => snapshot_pptx(&zip, options, measurer).map_err(|error| error.to_string()),
        other => Err(format!("Unsupported OOXML format: {other}")),
    }
}
