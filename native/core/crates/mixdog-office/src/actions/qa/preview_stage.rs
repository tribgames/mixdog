//! The pixels QA reads: the current preview (reused, rendered, or a structural or measure-only stand-in) and the visual diff against
//! the transaction baseline (`core/office-qa/preview-stage.mjs`).

use std::path::Path;
use std::sync::{Arc, Mutex};

use mixdog_fsio::WriteProof;
use mixdog_js::{to_number, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_office_quality::visual_diff::compare_rendered_pages;
use serde_json::{Map, Value, json};

use crate::actions::{Host, Machine};
use crate::batch::BatchHost;
use crate::render::preview::{PreviewOptions, render_office_preview};
use crate::render::{RenderEngine, cached_office_preview};
use crate::session::open::SessionCloser;
use crate::session::registry::lock;
use crate::session::{Backend, Mode, SessionHandle, SessionState};

/// `renderPdfPages`' default width.
const DEFAULT_MAX_WIDTH: f64 = 1400.0;

/// What the comparison with the transaction baseline answers.
pub struct Compared {
    pub baseline: Value,
    pub visual_diff: Value,
    pub diff_images: Vec<Value>,
}

/// The preview stand-in when nothing is rendered: a structural read or a measure-only pass.
pub fn unrendered_preview(target: &str, measure_only: bool) -> Value {
    let (mode, reason) = if measure_only {
        ("measure-only", "render: false \u{2014} fit, bounds, contrast, and facts were measured without rendering; render before the visual read.")
    } else {
        ("structural", "Delimited text has no paginated visual layout.")
    };
    json!({
        "output": target,
        "pageCount": 0,
        "visualCoverage": {
            "mode": mode,
            "reason": reason,
            "reviewedPages": [],
            "reviewed": 0,
            "total": 0,
            "complete": true,
            "remainingPages": [],
        },
        "images": [],
        "_images": [],
    })
}

/// `{ ...args, key: value }`.
fn with_field(args: &Value, key: &str, value: Value) -> Value {
    let mut fields = args.as_object().cloned().unwrap_or_default();
    fields.insert(key.to_owned(), value);
    Value::Object(fields)
}

/// `output.replace(/\.pdf$/i, '-before.pdf')`: a name that does not end in `.pdf` is left as it is.
fn before_name(output: &str) -> String {
    match output.len().checked_sub(4).and_then(|at| output.get(at..)) {
        Some(tail) if tail.eq_ignore_ascii_case(".pdf") => format!("{}-before.pdf", &output[..output.len() - 4]),
        _ => output.to_owned(),
    }
}

/// An array field as a list of values.
pub(crate) fn list(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

impl<P: WriteProof, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, P, H, C, R, B> {
    /// `renderTransactionBaseline(session, args, cwd, currentOutput)`: the pages of the document as the transaction found it.
    async fn render_transaction_baseline(&self, handle: &SessionHandle, args: &Value, cwd: &Path, current_output: &str) -> Result<Value, String> {
        let transaction = lock(handle).state.transaction().cloned();
        let Some(transaction) = transaction else { return Ok(json!({ "available": false, "reason": "No active transaction baseline." })) };
        let engine = self.engine();
        if !transaction.baseline_pdf.is_empty() && engine.exists(Path::new(&transaction.baseline_pdf)).await {
            let pages: Option<Vec<f64>> = args.get("pages").and_then(Value::as_array).map(|pages| pages.iter().map(to_number).collect());
            let max_width = match args.get("maxWidth") {
                Some(width) if !width.is_null() => to_number(width),
                _ => DEFAULT_MAX_WIDTH,
            };
            let cancel = lock(handle).active_signal.clone();
            let rendered = engine.rasterize(Path::new(&transaction.baseline_pdf), pages.as_deref(), max_width, cancel).await?;
            let mut baseline = Map::new();
            baseline.insert("available".to_owned(), Value::Bool(true));
            baseline.insert("output".to_owned(), Value::String(transaction.baseline_pdf.clone()));
            if let Value::Object(fields) = rendered {
                baseline.extend(fields);
            }
            return Ok(Value::Object(baseline));
        }
        if transaction.checkpoint.is_empty() || !engine.exists(Path::new(&transaction.checkpoint)).await {
            return Ok(json!({ "available": false, "reason": "The transaction backend has no renderable checkpoint." }));
        }
        let baseline_output = before_name(current_output);
        let mut copy = lock(handle).clone();
        copy.target = transaction.checkpoint.clone();
        copy.mode = if copy.backend == Backend::MicrosoftOfficeCom { Mode::Background } else { Mode::Portable };
        copy.state = SessionState::Idle;
        let baseline_session = Arc::new(Mutex::new(copy));
        let rendered = render_office_preview(engine, &baseline_session, &with_field(args, "output", Value::String(baseline_output)), cwd, PreviewOptions::default()).await?;
        Ok(json!({
            "available": true,
            "output": rendered.get("output").cloned().unwrap_or(Value::Null),
            "pageCount": rendered.get("pageCount").cloned().unwrap_or(Value::Null),
            "images": rendered.get("_images").cloned().unwrap_or(Value::Null),
        }))
    }

    /// `acquireQaPreview(session, args, cwd, { reuseRender, structuralReview, measureOnly })`.
    pub(crate) async fn acquire_qa_preview(&self, handle: &SessionHandle, args: &Value, cwd: &Path, reuse_render: bool, structural: bool, measure_only: bool) -> Result<Value, String> {
        let engine = self.engine();
        if reuse_render
            && !structural
            && let Some(prior) = cached_office_preview(engine, handle, args, cwd, true).await?
        {
            return Ok(prior);
        }
        if structural || measure_only {
            let target = lock(handle).target.clone();
            return Ok(unrendered_preview(&target, measure_only));
        }
        let width = match args.get("maxWidth") {
            Some(width) if !width.is_null() => Some(width.clone()),
            _ => lock(handle).design_state.rendered_max_width.clone(),
        };
        match width.filter(truthy) {
            Some(width) => render_office_preview(engine, handle, &with_field(args, "maxWidth", width), cwd, PreviewOptions::default()).await,
            None => render_office_preview(engine, handle, args, cwd, PreviewOptions::default()).await,
        }
    }

    /// `compareQaBaseline(session, args, cwd, preview, { structuralReview, measureOnly })`.
    pub(crate) async fn compare_qa_baseline(&self, handle: &SessionHandle, args: &Value, cwd: &Path, preview: &Value, structural: bool, measure_only: bool) -> Compared {
        let mut baseline = json!({
            "available": false,
            "reason": if structural { "Delimited text uses structural QA instead of paginated rendering." } else { "No active transaction baseline." },
        });
        let mut visual_diff = json!({ "available": false, "pages": [], "changedPercent": 0 });
        let mut diff_images: Vec<Value> = Vec::new();
        if !structural && !measure_only {
            let output = preview.get("output").map(value_to_string).unwrap_or_default();
            let attempt: Result<(Value, Option<Value>, Vec<Value>), String> = async {
                let rendered = self.render_transaction_baseline(handle, args, cwd, &output).await?;
                if !rendered.get("available").is_some_and(truthy) {
                    return Ok((rendered, None, Vec::new()));
                }
                let before = list(rendered.get("images"));
                let after = list(preview.get("_images"));
                let compared = compare_rendered_pages(self.inspect().snapshot.proof, self.note(), &before, &after, Path::new(&output))?;
                let diff = json!({
                    "available": compared.get("available").cloned().unwrap_or(Value::Null),
                    "pages": compared.get("pages").cloned().unwrap_or(Value::Null),
                    "changedPercent": compared.get("changedPercent").cloned().unwrap_or(Value::Null),
                });
                Ok((rendered, Some(diff), list(compared.get("images"))))
            }
            .await;
            match attempt {
                Ok((rendered, diff, images)) => {
                    baseline = rendered;
                    if let Some(diff) = diff {
                        visual_diff = diff;
                    }
                    diff_images = images;
                }
                Err(reason) => baseline = json!({ "available": false, "reason": reason }),
            }
        }
        Compared { baseline, visual_diff, diff_images }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stand_in_says_why_nothing_was_drawn() {
        let measured = unrendered_preview("a.xlsx", true);
        assert_eq!(measured["visualCoverage"]["mode"], "measure-only");
        assert_eq!(measured["pageCount"], 0);
        let structural = unrendered_preview("a.csv", false);
        assert_eq!(structural["visualCoverage"]["reason"], "Delimited text has no paginated visual layout.");
        assert_eq!(structural["_images"], json!([]));
    }

    #[test]
    fn only_a_pdf_name_gets_the_before_suffix() {
        assert_eq!(before_name("C:/work/a.mixdog-preview.pdf"), "C:/work/a.mixdog-preview-before.pdf");
        assert_eq!(before_name("a.PDF"), "a-before.pdf");
        assert_eq!(before_name("a.png"), "a.png");
        assert_eq!(before_name("pdf"), "pdf");
    }
}
