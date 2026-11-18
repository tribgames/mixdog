//! Session lifecycle actions: save, close, and finalize, the gated pipeline recalculate, review, hold checks, save, validate, close
//! (`core/office-actions-lifecycle.mjs`; each stage is in [`super::finalize`]).

use std::time::Instant;

use mixdog_fsio::WriteProof;
use mixdog_js::js_to_lowercase;
use mixdog_office_base::values::truthy;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use super::finalize::StepMetrics;
use super::finalize::holds::{HoldContext, finalize_hold, review_hold};
use super::finalize::review_stage::briefed_document;
use super::finalize::session_save::{close_session, save_session};
use super::{Host, Machine};
use crate::batch::BatchHost;
use crate::render::{RenderEngine, recalculate_for_review};
use crate::session::SessionHandle;
use crate::session::open::SessionCloser;
use crate::session::registry::lock;
use crate::transactions::TransactionError;

impl<P: WriteProof, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, P, H, C, R, B> {
    /// `save(session)`.
    /// With `output`, the saved document is also written there as a copy and the session stays on its own file.
    pub async fn save(&self, handle: &SessionHandle, args: &Value, signal: Option<&CancellationToken>) -> Result<Value, TransactionError> {
        let mut saved = save_session(self.host(), handle).await?;
        let output = args.get("output").and_then(Value::as_str).map(mixdog_js::js_trim).filter(|output| !output.is_empty());
        let Some(output) = output else { return Ok(saved) };
        let (id, format, mode, target, microsoft_office) = {
            let session = lock(handle);
            (session.id.clone(), session.format.clone(), session.mode.as_str(), session.target.clone(), session.is_microsoft_office())
        };
        self.note().note_write(std::path::Path::new(output));
        if microsoft_office {
            let request = json!({ "action": "save_copy", "session": id, "format": format, "mode": mode, "path": target, "output": output });
            let answer = self.host().call(&request, signal, Some(std::time::Duration::from_millis(120_000))).await;
            if !answer.get("ok").is_some_and(truthy) {
                let reason = answer.get("error").filter(|error| truthy(error)).map_or_else(|| "Microsoft Office save-copy failed".to_owned(), mixdog_js::value_to_string);
                return Err(reason.into());
            }
        } else {
            mixdog_fsio::copy(self.design().lane, &target, output).map_err(|error| error.to_string())?;
        }
        if let Some(fields) = saved.as_object_mut() {
            fields.insert("output".to_owned(), Value::String(output.to_owned()));
        }
        Ok(saved)
    }

    /// `closeSession(session, { save, signal })`: the session closed and forgotten.
    pub async fn close(&self, handle: &SessionHandle, save: bool, signal: Option<&CancellationToken>) -> Result<Value, TransactionError> {
        let closed = close_session(self.host(), self.registry(), self.environment(), handle, save, signal).await?;
        self.forget(handle);
        Ok(closed)
    }

    /// `finalize(session, args, cwd, signal)`: the gated delivery of a document, or the hold that says what stands in its way.
    pub async fn finalize(&self, handle: &SessionHandle, args: &Value, cwd: &str) -> Result<Value, TransactionError> {
        let mut metrics = StepMetrics::default();
        let (id, format, created, authored, authored_frame, briefed, requires_review) = {
            let session = lock(handle);
            if session.state.transaction().is_some() {
                return Err("Commit or roll back the active Office transaction before finalizing".into());
            }
            let native = session.design.as_ref().and_then(|design| design.get("authoring")).and_then(Value::as_str) == Some("native");
            (
                session.id.clone(),
                session.format.clone(),
                session.created,
                session.authored.authored || native,
                session.authored.frame,
                briefed_document(&session.format, session.authored.brief.as_ref()),
                session.design_state.requires_visual_review,
            )
        };
        let fail_on = match args.get("failOn").filter(|value| truthy(value)) {
            Some(value) => js_to_lowercase(&mixdog_js::value_to_string(value)),
            None if created && !authored => "warning".to_owned(),
            None => "error".to_owned(),
        };
        // A PDF of designed pages is the author's deck on paper and owes the deck's critique.
        let requires_visual_review = authored_frame || briefed || (format == "pptx" && requires_review);
        let started = Instant::now();
        let recalculated = recalculate_for_review(self.engine(), handle).await;
        metrics.record("recalculation", started);
        let recalculation = recalculated?.unwrap_or(Value::Null);
        if recalculation.get("needed").is_some_and(truthy) && !recalculation.get("recalculated").is_some_and(truthy) {
            let next = recalculation.get("reason").filter(|reason| truthy(reason)).cloned().unwrap_or_else(|| json!("Open the workbook in Microsoft Office background mode and finalize again."));
            let context = HoldContext { session: &id, fail_on: &fail_on, recalculation: &recalculation, metrics: &metrics, requires_visual_review };
            return Ok(finalize_hold(&context, "recalculation_failed", vec![("nextAction", next)]));
        }
        let stage = self.review_for_finalize(handle, args, cwd, &mut metrics, &fail_on, authored).await?;
        let hold = {
            let context = HoldContext { session: &id, fail_on: &fail_on, recalculation: &recalculation, metrics: &metrics, requires_visual_review };
            review_hold(&context, args, &stage)
        };
        if let Some(hold) = hold {
            return Ok(hold);
        }
        let started = Instant::now();
        let saved = self.save_for_finalize(handle, args, stage.reviewed.as_ref()).await;
        metrics.record("save", started);
        let saved = saved?;
        let started = Instant::now();
        let validation = self.validate_for_finalize(handle, args).await;
        metrics.record("validation", started);
        let validation = validation?;
        let review = stage.review.clone().unwrap_or(Value::Null);
        let design = lock(handle).design.clone();
        if !validation.get("ok").is_some_and(truthy) {
            let context = HoldContext { session: &id, fail_on: &fail_on, recalculation: &recalculation, metrics: &metrics, requires_visual_review };
            let mut extra = vec![("review", review), ("validation", validation)];
            if let Some(design) = design {
                extra.push(("design", design));
            }
            extra.push(("nextAction", json!("Fix the validation failure, then call finalize again.")));
            extra.push(("_images", Value::Array(stage.review_images.clone())));
            return Ok(finalize_hold(&context, "validation_failed", extra));
        }
        let closing = self.close_for_finalize(handle, &mut metrics).await?;
        let target = lock(handle).target.clone();
        let flag = |value: &Value, key: &str| value.get(key) == Some(&Value::Bool(true));
        let mut result = Map::new();
        result.insert("ok".to_owned(), Value::Bool(true));
        result.insert("finalized".to_owned(), Value::Bool(true));
        result.insert("session".to_owned(), Value::String(id));
        result.insert("path".to_owned(), Value::String(target));
        result.insert("failOn".to_owned(), Value::String(fail_on));
        result.insert("saved".to_owned(), Value::Bool(flag(&saved, "saved")));
        result.insert("saveSkipped".to_owned(), Value::Bool(flag(&saved, "skipped")));
        result.insert("closed".to_owned(), Value::Bool(flag(&closing.closed, "closed")));
        if let Some(cleanup) = closing.closed.get("cleanup").filter(|cleanup| truthy(cleanup)) {
            result.insert("cleanup".to_owned(), cleanup.clone());
        }
        result.insert("recalculation".to_owned(), recalculation);
        result.insert("review".to_owned(), review);
        result.insert("validation".to_owned(), validation);
        if let Some(design) = design {
            result.insert("design".to_owned(), design);
        }
        result.insert("composition".to_owned(), closing.composition);
        result.insert("compositionHistory".to_owned(), closing.composition_history);
        if !closing.composition_history_warning.is_empty() {
            result.insert("compositionHistoryWarning".to_owned(), Value::String(closing.composition_history_warning));
        }
        result.insert("stepMetrics".to_owned(), metrics.to_value());
        result.insert("_images".to_owned(), Value::Array(stage.review_images));
        Ok(Value::Object(result))
    }
}
