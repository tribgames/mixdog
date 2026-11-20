//! The QA action (`qa` of `core/office-actions-render.mjs`): a pipeline of audit (and the optional auto-fix), preview and baseline
//! diff, structural design review, rendered-page review, and the merged verdict.
//!
//! - [`fix_operations`]: the repairs `autoFix` may apply on its own.
//! - [`preview_stage`]: the pixels the review reads and the visual diff against the transaction's baseline.
//! - [`design_review_stage`]: the structural design review with the per-page roles.
//! - [`review_assembly`]: the issues merged and normalised, the checklist, the polish plan and the release score in one review.

pub mod design_review_stage;
pub mod fix_operations;
pub mod preview_stage;
pub mod review_assembly;

use std::path::Path;

use mixdog_fsio::WriteProof;
use mixdog_js::to_number_of;
use mixdog_office_base::values::truthy;
use mixdog_office_pdf::adapter::{SnapshotOptions, snapshot_pdf};
use mixdog_office_quality::forced_breaks::{BreakPreview, BreakSession, forced_break_pages};
use mixdog_office_quality::pipeline::normalize_office_review_issues;
use mixdog_office_quality::rendered::{RenderedOptions, is_small_worksheet_document, review_rendered_office_pages};
use serde_json::{Map, Value, json};

use self::fix_operations::qa_fix_operations;
use self::preview_stage::list;
use self::review_assembly::{Assembly, assemble_qa_review};
use crate::actions::{Host, Machine};
use crate::batch::{BatchHost, apply_batch};
use crate::inspect::issues;
use crate::render::{RenderEngine, recalculate_for_review};
use crate::session::open::SessionCloser;
use crate::session::registry::lock;
use crate::session::{Backend, SessionHandle};
use crate::transactions::{TransactionError, persist_office_transaction};

/// The page numbers a review reads as blank (`blank_page` at `/page[n]`).
fn blank_pages(review: &Value) -> Vec<f64> {
    list(review.get("issues"))
        .iter()
        .filter(|issue| issue.get("code").and_then(Value::as_str) == Some("blank_page"))
        .filter_map(|issue| issue.get("path").and_then(Value::as_str)?.strip_prefix("/page[")?.strip_suffix(']')?.parse().ok())
        .collect()
}

/// The issues of the rendered-page review as the gate reads them: severities settled by their code, so the review shows the severity
/// finalize blocks on. A page is read blank from its ink, which a worksheet page of a few cells barely has; a page that `occupied` names
/// carries text in the PDF it was drawn from, so it is not blank and the reading is dropped.
fn settle_rendered_issues(review: &mut Value, occupied: &[f64]) {
    let mut issues = list(review.get("issues"));
    issues.retain(|issue| {
        let page = issue.get("path").and_then(Value::as_str).and_then(|path| path.strip_prefix("/page[")?.strip_suffix(']')?.parse::<f64>().ok());
        !(issue.get("code").and_then(Value::as_str) == Some("blank_page") && page.is_some_and(|page| occupied.contains(&page)))
    });
    if let Some(fields) = review.as_object_mut() {
        fields.insert("issues".to_owned(), Value::Array(normalize_office_review_issues(&issues)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_page_that_carries_text_is_dropped_and_the_review_shows_the_severity_the_gate_uses() {
        let issue = |code: &str, page: u32| json!({ "code": code, "path": format!("/page[{page}]"), "message": "m", "severity": "warning" });
        let mut review = json!({ "issues": [issue("blank_page", 2), issue("blank_page", 3), issue("page_bottom_empty", 2)] });
        assert_eq!(blank_pages(&review), [2.0, 3.0]);
        settle_rendered_issues(&mut review, &[2.0]);
        let kept: Vec<(String, String)> = review["issues"]
            .as_array()
            .expect("issues")
            .iter()
            .map(|i| (i["code"].as_str().expect("code").to_owned(), i["path"].as_str().expect("path").to_owned()))
            .collect();
        // Page 2 has text and is not blank; page 3 is still blank, as an error the gate blocks on.
        assert_eq!(kept, [("blank_page".to_owned(), "/page[3]".to_owned()), ("page_bottom_empty".to_owned(), "/page[2]".to_owned())]);
        assert_eq!(review["issues"][0]["severity"], "error");
    }

    struct NoForms;

    /// A two-page PDF: page 1 draws nothing, page 2 draws one short line (a sparse page).
    fn two_page_pdf() -> Vec<u8> {
        let stream = "BT /F1 12 Tf 72 700 Td (Q4) Tj ET";
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>".to_owned(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (number, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", number + 1).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for offset in offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
        pdf
    }

    impl mixdog_office_pdf::adapter::FormView for NoForms {
        fn describe_fields(&self, _document: &mixdog_pdf::write::PdfDocument) -> Vec<Value> {
            Vec::new()
        }

        fn minimum_size(&self, _field_type: &str) -> (f64, f64) {
            (24.0, 12.0)
        }

        fn rectangles_overlap(&self, _left: &Value, _right: &Value) -> bool {
            false
        }
    }
    #[test]
    fn a_page_with_a_line_of_text_is_not_blank_beside_a_page_that_draws_nothing() {
        let folder = std::env::temp_dir().join(format!("mixdog-qa-blank-{}", std::process::id()));
        mixdog_fsio::create_dir_all(&mixdog_fsio::Unlaned, &folder).expect("folder");
        let path = folder.join("two.pdf");
        mixdog_fsio::write(&mixdog_fsio::Unlaned, &path, two_page_pdf()).expect("the pdf");
        let occupied = pages_with_text(&mixdog_fsio::Unlaned, &NoForms, &path.display().to_string(), &[1.0, 2.0]);
        mixdog_fsio::remove_dir_all(&mixdog_fsio::Unlaned, &folder).expect("clean up");
        // Only page 2 holds extracted text; page 1 yields the no-text marker, which is not text.
        assert_eq!(occupied, [2.0]);
    }
}

impl<P: WriteProof, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, P, H, C, R, B> {
    /// `qa(session, args, cwd, { reuseRender })`.
    pub async fn qa(&self, handle: &SessionHandle, args: &Value, cwd: &str, reuse_render: bool) -> Result<Value, TransactionError> {
        // A portable workbook is calculated before it is read or drawn: the pixels then show the values the file holds, and
        // finalize's own recalculation finds nothing to change, so the review token the caller brings back is still the current
        // one. Recalculating only at finalize made every first render of a formula workbook stale by construction.
        recalculate_for_review(self.engine(), handle).await?;
        let before = issues(self.inspect(), handle, args).await?;
        let (format, backend, target) = {
            let session = lock(handle);
            (session.format.clone(), session.backend, session.target.clone())
        };
        let auto_fix = args.get("autoFix") == Some(&Value::Bool(true));
        let fixes = if auto_fix { qa_fix_operations(&format, backend, &list(before.get("issues"))) } else { Vec::new() };
        let mut fixed: Option<Value> = None;
        if !fixes.is_empty() {
            fixed = Some(apply_batch(self.batch, handle, &json!({ "operations": fixes, "audit": false })).await?);
        }
        let after = if fixes.is_empty() { before.clone() } else { issues(self.inspect(), handle, args).await? };
        let structural = backend == Backend::MixdogTabular;
        // The measure pass of the authoring loop: fit, bounds, contrast, and the fact sheet are read from the document, not from
        // pixels, so `render: false` skips the preview and the loop costs a few seconds instead of a render each turn. What only
        // the rendered page can show is left to the pass that follows.
        let measure_only = args.get("render") == Some(&Value::Bool(false)) && !structural;
        let cwd_path = Path::new(cwd);
        let preview = self.acquire_qa_preview(handle, args, cwd_path, reuse_render, structural, measure_only).await?;
        let compared = self.compare_qa_baseline(handle, args, cwd_path, &preview, structural, measure_only).await;
        let design = self.review_qa_design(handle, args).await;
        let images = list(preview.get("_images"));
        let render_review = if structural {
            json!({ "ok": true, "format": format, "pages": [], "issues": [] })
        } else {
            let (html_source, edits, frame) = {
                let session = lock(handle);
                (session.authored.html_source.clone(), session.authored.html_source_edits > 0, session.authored.frame)
            };
            let output = preview.get("output").and_then(Value::as_str).unwrap_or_default();
            let forced = forced_break_pages(
                self.inspect().snapshot.proof,
                &BreakSession { format: &format, target: Path::new(&target), html_source: html_source.as_deref().map(Path::new), html_source_edits: edits },
                &BreakPreview { has_images: !images.is_empty(), output, export_available: preview.get("exportAvailable").and_then(Value::as_bool) },
            )?;
            let document = design.current_snapshot.as_ref().and_then(|read| read.get("document")).unwrap_or(&Value::Null);
            let mut review = review_rendered_office_pages(
                &images,
                &RenderedOptions {
                    format: format.clone(),
                    page_roles: design.page_roles.clone(),
                    small_worksheet: format == "xlsx" && is_small_worksheet_document(document),
                    page_count: to_number_of(preview.get("pageCount")),
                    designed_pages: frame,
                    forced_break_pages: forced.map(|pages| pages.into_iter().map(|page| page as f64).collect()),
                },
            )?;
            let occupied = if format == "xlsx" { self.pages_with_text(output, &review) } else { Vec::new() };
            settle_rendered_issues(&mut review, &occupied);
            review
        };
        let (trust, created) = {
            let from_read = design.current_snapshot.as_ref().and_then(|read| read.get("trust")).filter(|trust| truthy(trust)).cloned();
            let session = lock(handle);
            (from_read.or_else(|| session.caches.trust_review.clone().filter(truthy)).unwrap_or(Value::Null), session.created)
        };
        let assembled = assemble_qa_review(&Assembly {
            format: &format,
            created,
            args,
            preview: &preview,
            baseline: &compared.baseline,
            visual_diff: &compared.visual_diff,
            diff_images: &compared.diff_images,
            before: &before,
            after: &after,
            fixes: fixes.len(),
            design: &design,
            render_review: &render_review,
            trust: &trust,
            created_at: self.now_iso(),
        });
        let in_transaction = {
            let mut session = lock(handle);
            match session.state.transaction_mut() {
                Some(transaction) => {
                    transaction.review = Some(assembled.review.clone());
                    true
                }
                None => false,
            }
        };
        if in_transaction {
            persist_office_transaction(&self.batch.transactions(), handle, None).map_err(TransactionError::Failed)?;
        }
        let blocking = assembled.combined_issues_after.iter().any(|entry| matches!(entry.get("severity").and_then(Value::as_str), Some("error" | "warning")));
        let (id, mode, backend_name) = {
            let session = lock(handle);
            (session.id.clone(), session.mode.as_str(), session.backend.as_str())
        };
        let mut shown = Map::new();
        for key in ["output", "pageCount", "visualCoverage", "images", "reviewToken"] {
            if let Some(value) = preview.get(key) {
                shown.insert(key.to_owned(), value.clone());
            }
        }
        shown.insert("reused".to_owned(), Value::Bool(preview.get("reused") == Some(&Value::Bool(true))));
        if let Some(available) = preview.get("exportAvailable") {
            shown.insert("exportAvailable".to_owned(), available.clone());
        }
        let text = |value: Option<&Value>| value.filter(|value| truthy(value)).cloned().unwrap_or_else(|| json!(""));
        let mut all_images = images;
        all_images.extend(compared.diff_images.iter().cloned());
        Ok(json!({
            "ok": after.get("ok").is_some_and(truthy) && !blocking,
            "session": id,
            "mode": mode,
            "backend": backend_name,
            "autoFix": auto_fix,
            "fixes": fixes,
            "fixResult": fixed.unwrap_or(Value::Null),
            "issuesBefore": before.get("issues").cloned().unwrap_or(Value::Null),
            "issuesAfter": assembled.combined_issues_after,
            "review": assembled.review,
            "preview": Value::Object(shown),
            "baseline": {
                "available": compared.baseline.get("available").cloned().unwrap_or(Value::Null),
                "output": text(compared.baseline.get("output")),
                "reason": text(compared.baseline.get("reason")),
            },
            "_images": all_images,
        }))
    }
}
/// Which of the `blank` pages carry text in the PDF they were drawn from (`output`): the pages the PDF read names as having no text
/// layer (`likelyScannedPages`, a list of page numbers) are blank, the others carry text. A PDF that cannot be read proves nothing.
fn pages_with_text<P: mixdog_fsio::ReadProof>(proof: &P, forms: &dyn mixdog_office_pdf::adapter::FormView, output: &str, blank: &[f64]) -> Vec<f64> {
    if blank.is_empty() || output.is_empty() {
        return Vec::new();
    }
    let options = SnapshotOptions::from_json(&json!({ "pages": blank, "maxChars": 100_000 }));
    let Ok(read) = snapshot_pdf(proof, Path::new(output), &options, forms) else { return Vec::new() };
    let without_text: Vec<f64> = list(read.get("likelyScannedPages")).iter().filter_map(Value::as_f64).collect();
    let read_pages: Vec<f64> = list(read.get("pages")).iter().filter_map(|page| page.get("index").and_then(Value::as_f64)).collect();
    read_pages.into_iter().filter(|page| !without_text.contains(page)).collect()
}
impl<P: WriteProof, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, P, H, C, R, B> {
    fn pages_with_text(&self, output: &str, review: &Value) -> Vec<f64> {
        let cx = &self.inspect().snapshot;
        pages_with_text(cx.proof, cx.forms, output, &blank_pages(review))
    }
}
