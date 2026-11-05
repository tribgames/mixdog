//! The memory-ingest exclusion predicate: which transcript rows are not
//! conversation. One home for compaction's conversation projection and the
//! memory index.

use std::sync::LazyLock;

use mixdog_core_api::domain::provider::Role;
use mixdog_js::js_trim;
use mixdog_js::js_trim_start;
use mixdog_js::JsRegex;

use crate::project::ACTIVE_TURN_CONTINUATION_ANCHOR;
use crate::project::SUMMARY_PREFIX_ANCHOR;
use crate::project::is_internal_runtime_notification;
use crate::project::is_model_visible_tool_completion_wrapper;

static REFERENCE_FILES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Reference files:\s*", "i"));
static SUMMARY_HEADER: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\nmessages=\d+\s+(?:sha256=|compact_type=)", ""));
static ASYNC_HEAD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Async .+ finished\.", "i"));

/// What the predicate reads of a row, whichever type the row has.
pub struct IngestView<'a> {
    pub role: Role,
    /// The first text of the content (a string, or the first text part).
    pub first_text: &'a str,
    /// `meta.source` as stored; empty when absent.
    pub meta_source: &'a str,
    /// The injected skill body marker (`meta: 'skill'`).
    pub skill_body: bool,
    pub has_tool_calls: bool,
}

fn excluded_user_text(view: &IngestView<'_>) -> bool {
    let text = view.first_text;
    let start = js_trim_start(text);
    matches!(
        view.meta_source,
        "task-notification" | "compact-summary" | "compact-active-turn-continuation" | "compact-execution-recovery"
    ) || REFERENCE_FILES.is_match(start)
        || js_trim(text) == "(attachment)"
        || (text.starts_with(SUMMARY_PREFIX_ANCHOR) && SUMMARY_HEADER.is_match(text))
        || view.skill_body
        || start.starts_with("<skill>")
        || text.contains(ACTIVE_TURN_CONTINUATION_ANCHOR)
        || start.starts_with("[mixdog-runtime]")
        || is_internal_runtime_notification(text)
        || is_model_visible_tool_completion_wrapper(text)
        || ASYNC_HEAD.is_match(start)
}

/// Whether the memory-ingest projection drops this row: synthetic rows
/// (reference files, summaries, runtime nudges, notifications) and the bare
/// `.` acknowledgement.
pub fn should_exclude_ingest_message(view: &IngestView<'_>) -> bool {
    match view.role {
        Role::User => excluded_user_text(view),
        Role::Assistant => js_trim(view.first_text) == "." && !view.has_tool_calls,
        _ => false,
    }
}
