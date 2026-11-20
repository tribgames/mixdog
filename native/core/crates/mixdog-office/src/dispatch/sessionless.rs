//! The Office Use actions that answer without a document session: the capability and environment reports (`detect`, `describe` with
//! no session), the transaction registry (`transactions`, `recover`), the standalone PDF security pass (`secure`), authoring
//! (`author`) and the session-opening actions (`open`, `attach`, `create`) (`core/office-sessionless-actions.mjs`).
//!
//! Every handled action answers a finished tool result; an action that needs a session answers `None` so the caller falls through to
//! the session-bound dispatch.

use std::time::Instant;

use mixdog_fsio::WriteProof;
use mixdog_js::js_to_lowercase;
use mixdog_office_base::formats::{FILE_KIND_TO_FORMAT, document_format, normalize_office_format};
use mixdog_office_base::values::truthy;
use mixdog_office_design::library::inspect_office_design_library;
use mixdog_office_pdf::ocr::pdf_ocr_readiness;
use mixdog_office_pdf::security::{SecureRequest, qpdf_available, secure_pdf};
use mixdog_pdf::embed::unicode_font_path;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use crate::actions::{Host, Machine};
use crate::author::{AuthorCall, AuthorError, author};
use crate::batch::BatchHost;
use crate::describe::{DescribeRequest, describe_office_capabilities};
use crate::inspect::text_arg;
use crate::render::RenderEngine;
use crate::session::mode::select_mode;
use crate::session::open::SessionCloser;
use crate::session::working_copy::{dirname, full_path};
use crate::transactions::{TransactionError, pending_office_transactions, recover_office_transaction};

/// A library that is off says so; its template index hash, check time, and blank warning are the runtime's own.
fn detected_design_library(library: Value) -> Value {
    if library.get("enabled") != Some(&Value::Bool(false)) {
        return library;
    }
    let mut shown = Map::new();
    shown.insert("enabled".to_owned(), Value::Bool(false));
    if let Some(warning) = library.get("warning").filter(|warning| truthy(warning)) {
        shown.insert("warning".to_owned(), warning.clone());
    }
    Value::Object(shown)
}

impl<P: WriteProof, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, P, H, C, R, B> {
    /// `detectAction(args, cwd, dataDir)`.
    async fn detect_action(&self, args: &Value) -> Result<Value, TransactionError> {
        let cwd = self.author.env.cwd;
        let path = text_arg(args, "path");
        let (format, full) = if path.is_empty() { (String::new(), String::new()) } else { (document_format(&path)?.to_owned(), full_path(&path, cwd)?) };
        let office = self.host().detect(&format, &full).await;
        let lane = self.design().lane;
        let ocr = pdf_ocr_readiness(&self.author.lanes, self.data_dir()).await.map_err(|error| error.message)?;
        let pending = pending_office_transactions(&self.batch.transactions(), self.data_dir())?;
        let library = inspect_office_design_library(lane, self.environment(), self.data_dir(), None)?;
        Ok(json!({
            "ok": true,
            "microsoftOffice": office,
            "portable": {
                "ooxml": true,
                "pdf": true,
                "formats": FILE_KIND_TO_FORMAT.iter().map(|(kind, _)| json!(kind)).collect::<Vec<Value>>(),
                "pdfSecurity": { "available": qpdf_available(), "backend": "qpdf" },
                "pdfUnicodeFont": unicode_font_path(lane, self.tools.fonts, ""),
                "pdfOcr": ocr,
            },
            "pendingTransactions": pending,
            "designLibrary": detected_design_library(library),
        }))
    }

    /// `secureAction(args, cwd, startedAt)`.
    fn secure_action(&self, args: &Value, started: Instant) -> Result<Value, TransactionError> {
        let cwd = self.author.env.cwd;
        let input = full_path(&text_arg(args, "path"), cwd)?;
        if document_format(&input)? != "pdf" {
            return Err("secure supports PDF files only".into());
        }
        let output = full_path(&text_arg(args, "output"), cwd)?;
        let mode = js_to_lowercase(&text_arg(args, "security"));
        if mode != "encrypt" && mode != "decrypt" {
            return Err("secure requires security: encrypt or decrypt".into());
        }
        mixdog_fsio::create_dir_all(self.design().lane, dirname(&output)).map_err(|error| error.to_string())?;
        let password = text_arg(args, "password");
        let owner_password = text_arg(args, "ownerPassword");
        let secured = secure_pdf(
            self.design().lane,
            self.note(),
            &SecureRequest { input: &input, output: &output, mode: &mode, password: &password, owner_password: &owner_password },
        )
        .map_err(|error| error.message)?;
        Ok(self.tool_result(secured, "secure", None, started, &[]))
    }

    /// `describeWithoutSession(args, cwd)`.
    async fn describe_without_session(&self, args: &Value) -> Result<Value, TransactionError> {
        let cwd = self.author.env.cwd;
        let path = text_arg(args, "path");
        let mut format = String::new();
        if !path.is_empty() {
            format = document_format(&path)?.to_owned();
        } else if args.get("format").is_some_and(truthy) {
            format = normalize_office_format(&text_arg(args, "format"))?.to_owned();
        }
        let mut backend = String::new();
        if !format.is_empty() && !path.is_empty() {
            let selected = select_mode(self.host(), args.get("mode"), &format, &full_path(&path, cwd)?).await?;
            backend = selected.backend.as_str().to_owned();
        }
        if backend.is_empty() {
            backend = text_arg(args, "backend");
        }
        let (target, operation) = (text_arg(args, "target"), text_arg(args, "operation"));
        Ok(describe_office_capabilities(&DescribeRequest { format: &format, backend: &backend, target: &target, operation: &operation })?)
    }

    /// `authorAction(args, cwd, dataDir, signal, startedAt)`.
    async fn author_action(&self, args: &Value, signal: Option<&CancellationToken>, started: Instant) -> Result<Value, TransactionError> {
        let call = AuthorCall { cwd: self.author.env.cwd, signal };
        let mut authored = author(self.author, args, &call).await.map_err(|error: AuthorError| TransactionError::Failed(error.message().to_owned()))?;
        let images = super::take_images(&mut authored);
        let handle = authored.get("session").filter(|id| truthy(id)).map(mixdog_js::value_to_string).and_then(|id| self.registry().get(&id));
        Ok(self.tool_result(authored, "author", handle.as_ref(), started, &images))
    }

    /// `runSessionlessOfficeAction({ action, args, cwd, dataDir, signal, startedAt })`: the tool result, or `None` when the action
    /// needs a session.
    pub async fn sessionless_action(
        &self,
        action: &str,
        args: &Value,
        signal: Option<&CancellationToken>,
        started: Instant,
    ) -> Result<Option<Value>, TransactionError> {
        let plain = |value: Value| Some(self.tool_result_plain(value));
        match action {
            "detect" => Ok(plain(self.detect_action(args).await?)),
            "transactions" => {
                let pending = pending_office_transactions(&self.batch.transactions(), self.data_dir())?;
                Ok(plain(json!({ "ok": true, "transactions": pending })))
            }
            "recover" => Ok(plain(recover_office_transaction(&self.batch.transactions(), args, self.data_dir()).await?)),
            "secure" => Ok(Some(self.secure_action(args, started)?)),
            "describe" if !args.get("session").is_some_and(truthy) => Ok(plain(self.describe_without_session(args).await?)),
            "author" => Ok(Some(self.author_action(args, signal, started).await?)),
            "open" | "attach" | "create" => {
                let cwd = self.author.env.cwd;
                Ok(Some(self.open_create_or_attach(action, args, cwd, signal, started).await?))
            }
            _ => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_library_that_is_off_says_only_that_and_its_warning() {
        let off = json!({ "enabled": false, "warning": "no pack", "templateIndexHash": "abc", "lastCheckedAt": 5 });
        assert_eq!(detected_design_library(off), json!({ "enabled": false, "warning": "no pack" }));
        assert_eq!(detected_design_library(json!({ "enabled": false, "warning": "" })), json!({ "enabled": false }));
        let on = json!({ "enabled": true, "lastCheckedAt": 5 });
        assert_eq!(detected_design_library(on.clone()), on);
    }
}
