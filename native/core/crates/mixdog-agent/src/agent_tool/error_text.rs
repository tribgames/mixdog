//! How a failure reads in the tool's answer (Node `errorLine(err, {surface: 'agent'})`).
//!
//! Node's presenter (`runtime/shared/err-text.mjs`) classifies provider, transport and
//! cancellation failures before it reaches the plain-message rules. The agent tool's own
//! failures are plain messages, so [`PlainErrorText`] ports only that tail; a job's failure,
//! which may be a provider's, reads through the full classification ([`PresentedErrorText`]).

use mixdog_ai::service::error_text::ErrorView;
use mixdog_ai::service::error_text::PresentOptions;
use mixdog_ai::service::error_text::present_error_text;
use mixdog_js::JsRegex;

pub trait ErrorText: Send + Sync {
    /// The one-line description of a failure message.
    fn present(&self, message: &str) -> String;
}

/// The plain-message rules: error prefix dropped, session and run ids hidden, whitespace
/// folded, long text cut.
pub struct PlainErrorText;

const MAX: usize = 240;

impl ErrorText for PlainErrorText {
    fn present(&self, message: &str) -> String {
        let prefix = JsRegex::new_static(r"^\s*(?:\[[^\]]*error[^\]]*\]|error)\s*[:-]\s*", "i");
        let stripped = match prefix.find(message) {
            Some(range) => mixdog_js::js_trim(&message[range.end..]).to_owned(),
            None => mixdog_js::js_trim(message).to_owned(),
        };
        let space = JsRegex::new_static(r"\s+", "");
        let one_line = mixdog_js::js_trim(&space.replace_all_with(&stripped, |_| " ".into())).to_owned();
        if one_line.is_empty() {
            return "Unknown error".into();
        }
        let closed = JsRegex::new_static(r#"Session\s+"sess_[^"]+"\s+closed:\s*"#, "gi");
        let text = closed.replace_all_with(&one_line, |_| "Session closed: ".into());
        let text = JsRegex::new_static(r"\bsess_[A-Za-z0-9_-]+\b", "g").replace_all_with(&text, |_| "session".into());
        let text = JsRegex::new_static(r"\brun_[A-Za-z0-9_-]{16,}\b", "g").replace_all_with(&text, |_| "run".into());
        let text = JsRegex::new_static(r"\s+", "g").replace_all_with(&text, |_| " ".into());
        let text = mixdog_js::js_trim(&text);
        if mixdog_js::utf16_len(text) > MAX {
            format!("{}...", mixdog_js::slice_utf16(text, MAX - 3))
        } else {
            text.to_owned()
        }
    }
}

/// `presentErrorText(error, { surface: 'agent' })`, as `completeBackgroundTask` stores a job's error.
pub struct PresentedErrorText;

impl ErrorText for PresentedErrorText {
    fn present(&self, message: &str) -> String {
        present_error_text(&ErrorView::message(message), &PresentOptions { surface: "agent".into(), ..PresentOptions::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A job whose provider stream was cut reads as Node's board stores it, not as the bare `terminated` of the failure.
    #[test]
    fn a_job_failure_reads_through_the_full_classification() {
        assert_eq!(PresentedErrorText.present("terminated"), "Connection to the provider was lost.");
        assert_eq!(PlainErrorText.present("terminated"), "terminated");
    }
}
