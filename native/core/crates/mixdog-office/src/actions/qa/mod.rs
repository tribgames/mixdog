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
use mixdog_office_quality::forced_breaks::{BreakPreview, BreakSession, forced_break_pages};
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
            review_rendered_office_pages(
                &images,
                &RenderedOptions {
                    format: format.clone(),
                    page_roles: design.page_roles.clone(),
                    small_worksheet: format == "xlsx" && is_small_worksheet_document(document),
                    page_count: to_number_of(preview.get("pageCount")),
                    designed_pages: frame,
                    forced_break_pages: forced.map(|pages| pages.into_iter().map(|page| page as f64).collect()),
                },
            )?
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
