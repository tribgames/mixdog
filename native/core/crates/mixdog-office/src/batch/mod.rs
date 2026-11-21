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
