//! Sub-agent orchestration: one ephemeral child run under the parent's
//! cancellation tree. The child's token is a child of the parent's, so a
//! parent abort reaches the child's provider call and tool tasks through the
//! same cancel-safe waits; nothing polls or times a child.

use async_trait::async_trait;
use mixdog_core_api::domain::provider::Role;
use tokio_util::sync::CancellationToken;

use crate::message::AgentMessage;
use crate::run::AgentError;
use crate::run::RunFailure;
use crate::run::RunOutput;

/// Cap on an agent role's synthesis (~3000 tokens at 4 bytes/token): long
/// answers would ride in the parent's context for the rest of its turn.
const BRIEF_CAP_BYTES: usize = 12 * 1024;

pub struct DispatchRequest {
    pub agent: String,
    pub prompt: String,
    /// `false` returns the synthesis uncapped.
    pub brief: bool,
    /// The abort that stops the child opted into salvage (a bounded hard
    /// deadline): assistant text the child already produced is returned
    /// instead of discarded. A user cancel never sets it.
    pub salvage_partial: bool,
}

/// Prepares the child session, waits for agent admission, and drives the
/// child's run to completion. Admission leases and status writes belong to the
/// implementation and end when the future does. Cancel-safe: dropping it
/// abandons the child.
#[async_trait]
pub trait ChildRunner: Send + Sync {
    /// Index of the first transcript message of this run (earlier ones are
    /// history and never salvaged).
    async fn run_child(
        &self,
        request: &DispatchRequest,
        cancel: CancellationToken,
    ) -> ChildResult;
}

pub struct ChildResult {
    pub start_index: usize,
    pub outcome: Result<RunOutput, RunFailure>,
}

#[derive(Debug)]
pub enum DispatchError {
    EmptyPrompt,
    Failed(AgentError),
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyPrompt => f.write_str("[agent-dispatch] prompt required"),
            Self::Failed(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for DispatchError {}

/// The synthesis capped at [`BRIEF_CAP_BYTES`] on a character boundary, with a
/// marker that names the full size.
pub fn apply_brief_cap(text: &str) -> String {
    let bytes = text.len();
    if bytes <= BRIEF_CAP_BYTES {
        return text.to_owned();
    }
    let mut end = BRIEF_CAP_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let approx_tokens = (bytes as f64 / 4.0).round() as u64;
    let kb = (bytes as f64 / 1024.0).round() as u64;
    format!(
        "{}\n\n... [TRUNCATED — full answer was ~{approx_tokens} tokens / {kb} KB. Re-run with brief:false for the complete synthesis]",
        &text[..end]
    )
}

/// Assistant text a stopped child produced during this run: every assistant
/// message from `start_index`, trimmed, a lone `.` dropped, joined by a blank
/// line.
pub fn partial_handoff_text(transcript: &[AgentMessage], start_index: usize) -> Option<String> {
    let parts: Vec<String> = transcript
        .iter()
        .skip(start_index)
        .filter(|m| m.role() == Role::Assistant)
        .map(|m| mixdog_js::js_trim(&m.text()).to_owned())
        .filter(|text| !text.is_empty() && text != ".")
        .collect();
    let joined = parts.join("\n\n");
    (!mixdog_js::js_trim(&joined).is_empty()).then_some(joined)
}

/// Runs one child to its answer under `parent`'s cancellation tree.
pub async fn dispatch(
    runner: &dyn ChildRunner,
    request: &DispatchRequest,
    parent: &CancellationToken,
) -> Result<String, DispatchError> {
    if request.prompt.is_empty() {
        return Err(DispatchError::EmptyPrompt);
    }
    let brief = |text: String| {
        if request.brief {
            apply_brief_cap(&text)
        } else {
            text
        }
    };
    let result = runner.run_child(request, parent.child_token()).await;
    match result.outcome {
        Ok(output) => Ok(brief(output.response.content)),
        Err(failure) => {
            let salvaged = if request.salvage_partial {
                partial_handoff_text(&failure.transcript, result.start_index)
            } else {
                None
            };
            match salvaged {
                Some(partial) => Ok(brief(partial)),
                None => Err(DispatchError::Failed(failure.error)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brief_cap_cuts_on_a_character_boundary_and_names_the_size() {
        let short = "x".repeat(BRIEF_CAP_BYTES);
        assert_eq!(apply_brief_cap(&short), short);
        let long = "한".repeat(BRIEF_CAP_BYTES);
        let capped = apply_brief_cap(&long);
        assert!(capped.contains("[TRUNCATED — full answer was ~9216 tokens / 36 KB."));
        assert!(capped.starts_with('한'));
        assert!(std::str::from_utf8(capped.as_bytes()).is_ok());
    }

    #[test]
    fn partial_handoff_skips_history_dots_and_blanks() {
        let transcript = vec![
            AgentMessage::assistant("old answer", Vec::new()),
            AgentMessage::user("go"),
            AgentMessage::assistant("  first ", Vec::new()),
            AgentMessage::assistant(".", Vec::new()),
            AgentMessage::assistant("second", Vec::new()),
        ];
        assert_eq!(
            partial_handoff_text(&transcript, 1).as_deref(),
            Some("first\n\nsecond")
        );
        assert_eq!(partial_handoff_text(&transcript[..2], 1), None);
    }
}
