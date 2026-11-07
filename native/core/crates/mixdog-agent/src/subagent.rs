//! Sub-agent orchestration: one ephemeral child run under the parent's
//! cancellation tree. The child's cancel is linked to the parent's, so a
//! parent abort reaches the child's provider call and tool tasks through the
//! same cancel-safe waits; nothing in this module polls or times a child (the
//! progress watchdog belongs to the runner).

use async_trait::async_trait;
use serde_json::Value;

use crate::agent_tool::flow::seams::AssistantText;
use crate::cancel::Cancel;

/// Cap on an agent role's synthesis (~3000 tokens at 4 bytes/token): long
/// answers would ride in the parent's context for the rest of its turn.
const BRIEF_CAP_BYTES: usize = 12 * 1024;

/// One dispatch (`makeAgentDispatch(opts)(callArgs)`). The call's own values (`preset`, `cwd`,
/// `idle_timeout_ms`, `source_name`) win over the factory options (`default_*`); the runner merges them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DispatchRequest {
    pub agent: String,
    pub prompt: String,
    /// `false` returns the synthesis uncapped.
    pub brief: bool,
    /// The abort that stops the child opted into salvage (a bounded hard
    /// deadline): assistant text the child already produced is returned
    /// instead of discarded. A user cancel never sets it. The runner reads it:
    /// a salvaged child has answered as far as its status and close go.
    pub salvage_partial: bool,
    /// An explicit route (`{ provider, model, .. }`) or a preset name; `None` takes the hidden
    /// role's configured route.
    pub preset: Option<Value>,
    /// The agent's filesystem scope; `None` is the "no caller workspace" sentinel.
    pub cwd: Option<String>,
    /// The progress watchdog's idle budget in milliseconds, when the caller names one.
    pub idle_timeout_ms: Option<f64>,
    /// The internal classification stamped on the session (`maintenance`).
    pub task_type: Option<String>,
    pub source_type: Option<String>,
    pub source_name: Option<String>,
    /// `opts.preset`, `opts.cwd`, `opts.idleTimeoutMs`, `opts.sourceName`: the factory's values.
    pub default_preset: Option<Value>,
    pub default_cwd: Option<String>,
    pub default_idle_timeout_ms: Option<f64>,
    pub default_source_name: Option<String>,
    /// `opts.permission`: the permission the factory asks for; `None` is unset (`??`).
    pub default_permission: Option<String>,
    pub parent_session_id: Option<String>,
    /// `opts.ownerSessionId`: `None` is unset (the owner is the parent), `Some(None)` is `null`.
    pub owner_session_id: Option<Option<String>>,
}

impl DispatchRequest {
    /// A request for `agent` with the capped synthesis and nothing else set.
    pub fn new(agent: impl Into<String>, prompt: impl Into<String>) -> Self {
        Self { agent: agent.into(), prompt: prompt.into(), brief: true, ..Self::default() }
    }
}

/// Resolves the preset, prepares the child session, waits for agent admission, runs the ask and
/// closes the session. Admission leases and status writes belong to the implementation and end
/// when the future does. Cancel-safe: dropping it abandons the child.
#[async_trait]
pub trait ChildRunner: Send + Sync {
    async fn run_child(&self, request: &DispatchRequest, cancel: Cancel) -> ChildResult;
}

pub struct ChildResult {
    /// The reply text, or the message Node's dispatch threw.
    pub outcome: Result<String, String>,
}

#[derive(Debug, PartialEq)]
pub enum DispatchError {
    /// `[agent-dispatch] prompt required for agent "<agent>"`.
    EmptyPrompt(String),
    Failed(String),
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyPrompt(agent) => write!(f, "[agent-dispatch] prompt required for agent \"{agent}\""),
            Self::Failed(message) => f.write_str(message),
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

/// Assistant text a stopped child produced during this run (`partialHandoffTextFromSession`):
/// each row's own text, else the visible text of its provider replay, trimmed, a lone `.` and
/// blanks dropped, joined by a blank line.
pub fn partial_handoff_text(rows: &[AssistantText]) -> Option<String> {
    let parts: Vec<&str> = rows
        .iter()
        .map(|row| {
            let own = mixdog_js::js_trim(&row.content);
            if own.is_empty() { mixdog_js::js_trim(&row.replay) } else { own }
        })
        .filter(|text| !text.is_empty() && *text != ".")
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

/// Runs one child to its answer under `parent`'s cancellation tree.
pub async fn dispatch(runner: &dyn ChildRunner, request: &DispatchRequest, parent: &Cancel) -> Result<String, DispatchError> {
    if request.prompt.is_empty() {
        return Err(DispatchError::EmptyPrompt(request.agent.clone()));
    }
    let brief = |text: String| if request.brief { apply_brief_cap(&text) } else { text };
    match runner.run_child(request, Cancel::linked(std::slice::from_ref(parent))).await.outcome {
        Ok(text) => Ok(brief(text)),
        Err(message) => Err(DispatchError::Failed(message)),
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

    fn row(content: &str, replay: &str) -> AssistantText {
        AssistantText { content: content.into(), replay: replay.into() }
    }

    #[test]
    fn partial_handoff_reads_replay_text_for_blank_rows_and_skips_dots_and_blanks() {
        let rows = [row("  first ", ""), row(".", ""), row("", " from replay "), row("  ", ""), row("second", "unused")];
        assert_eq!(partial_handoff_text(&rows).as_deref(), Some("first\n\nfrom replay\n\nsecond"));
        assert_eq!(partial_handoff_text(&[row(".", ""), row("", "")]), None);
    }
}
