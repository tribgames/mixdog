//! How a document is held: `selectMode` of `core/office-sessions.mjs` and the Microsoft Office host the choice and the
//! attach go through.
//!
//! A PDF is always the portable PDF backend; CSV and TSV are the delimited-file backend and refuse `attach` and `visible`;
//! `portable` is the OOXML backend; anything else is Microsoft Office over COM when the host can run it (and, for `auto`,
//! when the application for the format is installed), otherwise the portable OOXML backend. `live` is `attach`.

use std::future::Future;

use mixdog_js::{js_to_lowercase, value_to_string};
use mixdog_office_base::formats::is_tabular_format;
use mixdog_office_base::values::truthy;
use mixdog_office_com::{CallOptions, OfficeCom};
use mixdog_rt::CancellationToken;
use serde_json::Value;

use super::{Backend, Mode};

/// The Microsoft Office host as open and create see it: whether it can run here, which applications are installed, and
/// the opening of a session in it (`microsoftOfficeComSupported`, `detectMicrosoftOffice`, `openMicrosoftOfficeSession`).
/// Answers are the host's JSON, failures in the same shape.
pub trait OfficeHost {
    fn supported(&self) -> bool;
    fn detect(&self, format: &str, path: &str) -> impl Future<Output = Value>;
    fn open_session(&self, payload: &Value, cancel: Option<&CancellationToken>) -> impl Future<Output = Value>;
}

impl OfficeHost for OfficeCom {
    fn supported(&self) -> bool {
        OfficeCom::supported(self)
    }

    async fn detect(&self, format: &str, path: &str) -> Value {
        OfficeCom::detect(self, format, path).await.value
    }

    async fn open_session(&self, payload: &Value, cancel: Option<&CancellationToken>) -> Value {
        let options = CallOptions { cancel: cancel.cloned().unwrap_or_else(CancellationToken::new), ..CallOptions::default() };
        OfficeCom::open_session(self, payload, options).await
    }
}

/// What `selectMode` answers: `{ mode, backend }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selected {
    pub mode: Mode,
    pub backend: Backend,
}

const PORTABLE_OOXML: Selected = Selected { mode: Mode::Portable, backend: Backend::MixdogOoxml };

/// `String(value || 'auto').toLowerCase()` of a `mode` argument.
pub fn requested_mode(value: Option<&Value>) -> String {
    match value.filter(|value| truthy(value)) {
        Some(value) => js_to_lowercase(&value_to_string(value)),
        None => "auto".to_owned(),
    }
}

/// `officeDetectionFor(result, format)?.installed`: whether the format's application is installed.
fn detection_installed(result: &Value, format: &str) -> bool {
    result
        .get("applications")
        .and_then(Value::as_array)
        .and_then(|applications| applications.iter().find(|entry| entry.get("format").and_then(Value::as_str) == Some(format)))
        .and_then(|entry| entry.get("installed"))
        .is_some_and(truthy)
}

/// `selectMode(requested, format, source)`.
pub async fn select_mode<H: OfficeHost>(host: &H, requested: Option<&Value>, format: &str, source: &str) -> Result<Selected, String> {
    if format == "pdf" {
        return Ok(Selected { mode: Mode::Portable, backend: Backend::MixdogPdf });
    }
    let mut mode = requested_mode(requested);
    if mode == "live" {
        mode = "attach".to_owned();
    }
    if !["auto", "attach", "visible", "background", "portable"].contains(&mode.as_str()) {
        return Err(format!("Unsupported Office mode: {mode}"));
    }
    if is_tabular_format(format) {
        if mode == "attach" || mode == "visible" {
            return Err(format!("{mode} is unsupported for {}; use auto, background, or portable mode", format.to_ascii_uppercase()));
        }
        return Ok(Selected { mode: Mode::Portable, backend: Backend::MixdogTabular });
    }
    if mode == "portable" {
        return Ok(PORTABLE_OOXML);
    }
    if !host.supported() {
        if mode == "attach" || mode == "visible" || mode == "background" {
            return Err(format!("{mode} Office editing requires Microsoft Office on Windows"));
        }
        return Ok(PORTABLE_OOXML);
    }
    if mode != "auto" {
        let mode = Mode::parse(&mode).unwrap_or(Mode::Background);
        return Ok(Selected { mode, backend: Backend::MicrosoftOfficeCom });
    }
    let detection = host.detect(format, source).await;
    if detection_installed(&detection, format) {
        return Ok(Selected { mode: Mode::Background, backend: Backend::MicrosoftOfficeCom });
    }
    Ok(PORTABLE_OOXML)
}

/// `validatePptxAuthorMode(requested)`: a deck written by an authoring script is never an attached or visible document.
pub fn validate_author_mode(requested: Option<&Value>) -> Result<String, String> {
    let mode = requested_mode(requested);
    if ["attach", "live", "visible"].contains(&mode.as_str()) {
        return Err("author requires auto, background, or portable mode".to_owned());
    }
    if !["auto", "background", "portable"].contains(&mode.as_str()) {
        return Err(format!("Unsupported Office mode: {mode}"));
    }
    Ok(mode)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Host {
        supported: bool,
        installed: bool,
    }

    impl OfficeHost for Host {
        fn supported(&self) -> bool {
            self.supported
        }

        fn detect(&self, format: &str, _path: &str) -> impl Future<Output = Value> {
            let answer = json!({ "applications": [{ "format": format, "installed": self.installed }] });
            async move { answer }
        }

        fn open_session(&self, _payload: &Value, _cancel: Option<&CancellationToken>) -> impl Future<Output = Value> {
            async { json!({ "ok": true }) }
        }
    }

    fn select(host: &Host, mode: Option<&str>, format: &str) -> Result<(Mode, Backend), String> {
        let requested = mode.map(Value::from);
        let future = select_mode(host, requested.as_ref(), format, "a");
        tokio::runtime::Builder::new_current_thread().build().expect("runtime").block_on(future).map(|selected| (selected.mode, selected.backend))
    }

    #[test]
    fn a_pdf_and_a_delimited_file_never_reach_office() {
        let host = Host { supported: true, installed: true };
        assert_eq!(select(&host, Some("visible"), "pdf"), Ok((Mode::Portable, Backend::MixdogPdf)));
        assert_eq!(select(&host, None, "csv"), Ok((Mode::Portable, Backend::MixdogTabular)));
        assert_eq!(select(&host, Some("LIVE"), "tsv"), Err("attach is unsupported for TSV; use auto, background, or portable mode".to_owned()));
        assert_eq!(select(&host, Some("visible"), "csv"), Err("visible is unsupported for CSV; use auto, background, or portable mode".to_owned()));
    }

    #[test]
    fn office_is_used_when_asked_for_and_when_the_application_is_installed() {
        let installed = Host { supported: true, installed: true };
        assert_eq!(select(&installed, None, "docx"), Ok((Mode::Background, Backend::MicrosoftOfficeCom)));
        assert_eq!(select(&installed, Some("live"), "xlsx"), Ok((Mode::Attach, Backend::MicrosoftOfficeCom)));
        assert_eq!(select(&installed, Some("portable"), "pptx"), Ok((Mode::Portable, Backend::MixdogOoxml)));
        let missing = Host { supported: true, installed: false };
        assert_eq!(select(&missing, Some("auto"), "docx"), Ok((Mode::Portable, Backend::MixdogOoxml)));
        assert_eq!(select(&missing, Some("visible"), "docx"), Ok((Mode::Visible, Backend::MicrosoftOfficeCom)));
    }

    #[test]
    fn without_office_only_auto_and_portable_work() {
        let host = Host { supported: false, installed: false };
        assert_eq!(select(&host, None, "docx"), Ok((Mode::Portable, Backend::MixdogOoxml)));
        assert_eq!(select(&host, Some("background"), "docx"), Err("background Office editing requires Microsoft Office on Windows".to_owned()));
        assert_eq!(select(&host, Some("sideways"), "docx"), Err("Unsupported Office mode: sideways".to_owned()));
    }

    #[test]
    fn an_authored_deck_is_never_attached() {
        assert_eq!(validate_author_mode(None), Ok("auto".to_owned()));
        assert_eq!(validate_author_mode(Some(&json!("Portable"))), Ok("portable".to_owned()));
        assert_eq!(validate_author_mode(Some(&json!("live"))), Err("author requires auto, background, or portable mode".to_owned()));
        assert_eq!(validate_author_mode(Some(&json!("x"))), Err("Unsupported Office mode: x".to_owned()));
    }
}
