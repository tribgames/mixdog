//! The commit stage of finalize: persist the file (or reuse the batch that already saved it), run the post-save validation, then
//! close the session and record the composition history for a newly created document (`core/office-finalize/commit-stage.mjs`).

use std::time::Instant;

use mixdog_fsio::WriteLane;
use mixdog_js::{to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_office_design::composition::summarize_office_compositions;
use mixdog_office_design::library::{CompositionRecord, record_office_composition_history};
use serde_json::{Value, json};

use super::StepMetrics;
use super::session_save::{close_session, save_session};
use crate::actions::{Host, Machine};
use crate::batch::BatchHost;
use crate::inspect::{validate, with_fields};
use crate::render::RenderEngine;
use crate::session::Mode;
use crate::session::SessionHandle;
use crate::session::open::SessionCloser;
use crate::session::registry::lock;

/// What the close of a finalize settled.
pub struct Closing {
    pub composition: Value,
    pub closed: Value,
    pub composition_history: Value,
    pub composition_history_warning: String,
}

impl<L: WriteLane, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, L, H, C, R, B> {
    /// `saveForFinalize(session, args, reviewed)`.
    pub(crate) async fn save_for_finalize(&self, handle: &SessionHandle, args: &Value, reviewed: Option<&Value>) -> Result<Value, String> {
        let fixes = reviewed.and_then(|reviewed| reviewed.get("fixesApplied")).filter(|fixes| truthy(fixes)).map_or(0.0, |fixes| to_number_of(Some(fixes)));
        if args.get("__alreadySaved") == Some(&Value::Bool(true)) && fixes == 0.0 {
            let session = lock(handle);
            return Ok(json!({ "ok": true, "session": session.id, "saved": true, "skipped": true, "path": session.target }));
        }
        save_session(self.host(), handle).await
    }

    /// `validateForFinalize(session, args)`.
    pub(crate) async fn validate_for_finalize(&self, handle: &SessionHandle, args: &Value) -> Result<Value, String> {
        let post_save = {
            let session = lock(handle);
            session.is_microsoft_office() && session.mode == Mode::Background
        };
        // The reopened workbook's full reading is dropped from finalize's answer (its fingerprint and issue count state the
        // persistence), and reading it cost a financial model's finalize 1.5 s.
        let request = with_fields(
            args,
            vec![("__postSave", json!(post_save)), ("__skipNative", json!(false)), ("__skipNativeIssues", json!(false)), ("__skipNativeSnapshot", json!(true))],
        );
        validate(self.inspect(), handle, &request).await
    }

    /// `closeForFinalize(session, signal, { timedStep })`.
    pub(crate) async fn close_for_finalize(&self, handle: &SessionHandle, metrics: &mut StepMetrics) -> Result<Closing, String> {
        let (format, compositions, signal) = {
            let session = lock(handle);
            (session.format.clone(), Value::Array(session.design_state.compositions.clone()), session.active_signal.clone())
        };
        let composition = summarize_office_compositions(&format, Some(&compositions));
        let started = Instant::now();
        let closed = close_session(self.host(), self.registry(), self.environment(), handle, false, signal.as_ref()).await;
        metrics.record("close", started);
        let closed = closed?;
        self.forget(handle);
        let mut history = Value::Null;
        let mut warning = String::new();
        let created = lock(handle).created;
        let fingerprint = composition.get("fingerprint").filter(|fingerprint| truthy(fingerprint)).map(value_to_string);
        if created && let Some(fingerprint) = fingerprint {
            let (target, data_dir, design) = {
                let session = lock(handle);
                (session.target.clone(), session.data_dir.clone(), session.design.clone())
            };
            let field = |name: &str| design.as_ref().and_then(|design| design.get(name)).map(value_to_string).unwrap_or_default();
            let ids = composition.get("compositionIds").cloned().unwrap_or(Value::Null);
            let record = CompositionRecord {
                document_path: &target,
                format: &format,
                profile: &field("profile"),
                purpose: &field("purpose"),
                expression_mode: &field("expressionMode"),
                fingerprint: &fingerprint,
                composition_ids: &ids,
            };
            match record_office_composition_history(self.design().lane, self.environment(), &data_dir, &record) {
                Ok(recorded) => history = recorded,
                Err(message) => warning = message,
            }
        }
        Ok(Closing { composition, closed, composition_history: history, composition_history_warning: warning })
    }
}
