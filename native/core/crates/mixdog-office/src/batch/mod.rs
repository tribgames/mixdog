//! The atomic batch of the office engine (`core/office-actions-batch.mjs`): a list of operations applied to a session's document
//! all together or not at all.
//!
//! - [`prepare`]: what the batch runs. The operations are checked against the contract, expanded by the design, localised to the
//!   caller's folder and given the defaults both backends share (a Word chart becomes the picture the PDF writer draws, a page size
//!   its two numbers, a figure column its alignment, a table style the name Excel stores).
//! - [`run`]: the pipeline. The trust gate, the working copy, the journal's `applying` mark, the backup the batch falls back to, the
//!   backend (Microsoft Office, the portable OOXML writer, the PDF writer, the delimited-file writer), the no-change check, and on
//!   success the snapshot version, the design state, the transaction's expected fingerprint and the inline audit. The backup and the
//!   scratch folders are removed whatever happens.
//!
//! `recalculateForReview` (`core/office-recalculation.mjs`) is [`crate::render::recalculate_for_review`]: the render stage that
//! owns it ported it with the engine it drives, and the batch never calls it, so there is one of it.
//!
//! What touches the machine beyond the lane the call runs on is a [`BatchHost`]: the PDF operation set of a call, the picture a
//! Word chart is drawn as, the readings a document brief is held to.

pub mod prepare;
pub mod run;

use std::future::Future;
use std::path::Path;

use mixdog_fsio::WriteProof;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_design::library::Environment;
use mixdog_office_pdf::content_ops::ContentOperations;
use mixdog_office_quality::document_brief::BriefReadings;
use mixdog_rt::CancellationToken;
use serde_json::Value;

pub use self::prepare::{Prepared, prepare_batch_operations, with_shared_chart_defaults};
pub use self::run::apply_batch;
use crate::inspect::InspectContext;
use crate::session::registry::Registry;
use crate::transactions::TransactionContext;

/// What a batch needs of the machine beyond the lane proof.
pub trait BatchHost {
    /// The PDF operation set of one call (`applyPdfBatch(path, operations, { dataDir, signal })`): the content operations carry the
    /// OCR data folder and the cancellation, and a set holds what the call has drawn on a page, so it is made for one batch.
    fn pdf_operations(&self, data_dir: &Path, cancel: Option<CancellationToken>) -> ContentOperations;

    /// `createChartPdf` and `renderPdfPages` of a Word chart: the chart `block` drawn `width` points wide into the PDF at `pdf`,
    /// its first page drawn as a picture (three pixels a point, so it stays sharp in print and at the zoom a reader uses) beside it.
    /// Answers the picture's path.
    fn chart_picture(&self, block: &Value, width: f64, pdf: &Path) -> impl Future<Output = Result<String, String>>;

    /// The brief parser and readings a document brief (`design.brief`) is held to.
    fn brief_readings(&self) -> &dyn BriefReadings;
}

/// What a batch runs with: the inspection context (the lane proof, the text measurer, the Office host, the audit), the write note of
/// the call, the sessions, the environment (the clock) and the machine.
pub struct BatchContext<'a, P: WriteProof, H, B> {
    pub inspect: &'a InspectContext<'a, P, H>,
    pub note: &'a dyn WriteNote,
    pub registry: &'a Registry,
    pub env: &'a Environment,
    pub host: &'a B,
}

impl<'a, P: WriteProof, H, B> BatchContext<'a, P, H, B> {
    pub(crate) fn lane(&self) -> &P {
        self.inspect.snapshot.proof
    }

    /// The context the transaction calls run with.
    pub fn transactions(&self) -> TransactionContext<'_, P, H> {
        TransactionContext { snapshot: &self.inspect.snapshot, note: self.note, registry: self.registry, env: self.env }
    }
}
