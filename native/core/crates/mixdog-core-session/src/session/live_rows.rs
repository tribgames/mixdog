//! The texts of a turn's live-only rows and notifications: notice polish
//! (`tui/session/notice-text.mjs`), the compact marker (`compact-event-label.mjs`,
//! `tui/session/labels.mjs`) and the usage delta (`loop/usage.mjs` `usageDeltaEvent`).

use std::sync::LazyLock;

use mixdog_agent::env::CompactEvent;
use mixdog_agent::env::CompactStatus;
use mixdog_agent::env::CompactTrigger;
use mixdog_core_api::domain::provider::Usage;
use regex::Regex;
use serde_json::Value;
use serde_json::json;

/// A JavaScript pattern: `\s` is `[\s\u{FEFF}]` and `·` stands for `.` (no line terminators).
fn js(pattern: &str) -> Regex {
    let pattern = pattern.replace(r"\s", r"[\s\x{FEFF}]").replace('·', r"[^\n\r\x{2028}\x{2029}]");
    Regex::new(&pattern).expect("notice pattern")
}

static ERROR: LazyLock<Regex> = LazyLock::new(|| js(r"(?i)^error\s*:\s*(·+)$"));
static COULD_NOT: LazyLock<Regex> = LazyLock::new(|| js(r"(?i)^could not\s+(·+?)(?::\s*(·+))?$"));
static FAILED: LazyLock<Regex> = LazyLock::new(|| js(r"(?i)^(·+?)\s+failed(?::\s*(·+))?$"));
static BUSY: LazyLock<Regex> = LazyLock::new(|| js(r"(?i)^(·+?)\s+already in progress\.?$"));
static REQUIRED: LazyLock<Regex> = LazyLock::new(|| js(r"(?i)^(·+?)\s+is required(?:\s+for\s+(·+))?\.?$"));

const FAILED_NOTICE_ACTIONS: &[(&str, &str)] = &[
    ("api key save", "save API key"),
    ("auth-forget", "forget auth"),
    ("auto-clear", "update auto-clear"),
    ("autoclear", "update auto-clear"),
    ("agent", "run agent command"),
    ("channels", "load channels"),
    ("channels update", "update channels"),
    ("clear", "clear chat"),
    ("compact", "compact context"),
    ("copy", "copy"),
    ("core memory", "load core memory"),
    ("cwd", "update working directory"),
    ("effort switch", "switch effort"),
    ("fast", "update fast mode"),
    ("hook rule update", "update hook rule"),
    ("hook toggle", "toggle hook"),
    ("hook update", "update hook"),
    ("hooks status", "load hooks"),
    ("local provider update", "update local provider"),
    ("mcp add", "add MCP server"),
    ("mcp reconnect", "reconnect MCP server"),
    ("mcp status", "load MCP status"),
    ("mcp toggle", "toggle MCP server"),
    ("memory", "run memory command"),
    ("memory status", "load memory status"),
    ("model save", "save model"),
    ("model switch", "switch model"),
    ("oauth code", "finish OAuth login"),
    ("oauth login", "start OAuth login"),
    ("output style switch", "switch output style"),
    ("openai usage auth save", "save OpenAI usage auth"),
    ("plugin add", "add plugin"),
    ("plugin mcp enable", "enable plugin MCP"),
    ("plugin uninstall", "uninstall plugin"),
    ("plugin update", "update plugin"),
    ("plugins status", "load plugins"),
    ("providers", "load providers"),
    ("recall", "run recall"),
    ("resume", "resume chat"),
    ("schedule toggle", "toggle schedule"),
    ("setup save", "save setup"),
    ("settings update", "update settings"),
    ("skill add", "add skill"),
    ("skills status", "load skills"),
    ("tools status", "load tool status"),
    ("usage", "load usage"),
    ("webhook toggle", "toggle webhook"),
    ("workflow switch", "switch workflow"),
];

const FAILED_NOTICE_SUFFIXES: &[(&str, &str)] = &[
    (" save", "save"),
    (" switch", "switch"),
    (" update", "update"),
    (" toggle", "toggle"),
    (" reconnect", "reconnect"),
    (" enable", "enable"),
    (" uninstall", "uninstall"),
    (" add", "add"),
];

fn polish_notice_action(action: &str) -> String {
    let value = mixdog_js::js_trim(action);
    if value.is_empty() {
        return "finish".into();
    }
    let key = value.to_lowercase();
    if let Some((_, known)) = FAILED_NOTICE_ACTIONS.iter().find(|(k, _)| *k == key) {
        return (*known).to_owned();
    }
    for (suffix, verb) in FAILED_NOTICE_SUFFIXES {
        if !key.ends_with(suffix) {
            continue;
        }
        let subject = value.get(..value.len() - suffix.len()).map(mixdog_js::js_trim).unwrap_or_default();
        return if subject.is_empty() { (*verb).to_owned() } else { format!("{verb} {subject}") };
    }
    value.to_owned()
}

fn sentence_start(text: &str) -> String {
    let value = mixdog_js::js_trim(text);
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `polishNoticeText(text)`.
pub(crate) fn polish_notice_text(text: &str) -> String {
    let trimmed = mixdog_js::js_trim(text);
    let mut value = match trimmed.strip_prefix('✓') {
        Some(rest) => rest.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}').to_owned(),
        None => trimmed.to_owned(),
    };
    if value.is_empty() {
        return String::new();
    }
    if let Some(rest) = ERROR.captures(&value).and_then(|c| c.get(1)).map(|m| m.as_str()).filter(|r| !r.is_empty()) {
        value = mixdog_js::js_trim(rest).to_owned();
    }
    if let Some(c) = COULD_NOT.captures(&value) {
        return match c.get(2).filter(|m| !m.as_str().is_empty()) {
            Some(why) => format!("Couldn’t {}: {}", &c[1], why.as_str()),
            None => format!("Couldn’t {}.", &c[1]),
        };
    }
    if let Some(c) = FAILED.captures(&value) {
        let action = polish_notice_action(&c[1]);
        return match c.get(2).filter(|m| !m.as_str().is_empty()) {
            Some(why) => format!("Couldn’t {action}: {}", why.as_str()),
            None => format!("Couldn’t {action}."),
        };
    }
    if let Some(c) = BUSY.captures(&value) {
        return format!("{} is already running.", sentence_start(&polish_notice_action(&c[1])));
    }
    if let Some(c) = REQUIRED.captures(&value) {
        let subject = mixdog_js::js_trim(&c[1]);
        return match c.get(2).map(|m| mixdog_js::js_trim(m.as_str())).filter(|t| !t.is_empty()) {
            Some(target) => format!("{subject} required for {target}."),
            None => format!("{subject} required."),
        };
    }
    value
}

/// The event's `status` as Node's loop reports it: a pass that failed, one that changed the
/// context, or one that changed nothing (`no_change`).
fn compact_status(event: &CompactEvent) -> &'static str {
    match event.status {
        CompactStatus::Failed => "failed",
        CompactStatus::Compacted => "compacted",
        CompactStatus::Skipped => "skipped",
        CompactStatus::NoChange => "no_change",
    }
}

/// Whether the pass changed the context (`applyCompactEvent`'s `compactChanged`).
pub(crate) fn compact_changed(event: &CompactEvent) -> bool {
    !matches!(compact_status(event), "failed" | "skipped" | "no_change")
}

/// `compactEventLabel(event)`.
pub(crate) fn compact_event_label(event: &CompactEvent) -> &'static str {
    let reactive = event.trigger == CompactTrigger::Reactive;
    match compact_status(event) {
        "failed" if reactive => "Compact failed (overflow retry)",
        "failed" => "Compact failed",
        "skipped" => "Compact skipped",
        "no_change" => "Compact checked",
        _ if reactive => "Compact complete (overflow recovery)",
        _ => "Compact complete",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(usage: Usage) -> super::super::run::UsageReport {
        super::super::run::UsageReport {
            iteration: 0,
            usage,
            model: "m".into(),
            requested_model: "m".into(),
            delta_tool_calls: 0,
            request_ms: 0,
            delta_prompt: 1000,
            send_tools: Default::default(),
            reasoning_tokens: None,
            reasoning_tokens_complete: true,
            outgoing: Vec::new().into(),
            sent_at_ms: 0,
            input_excludes_cache: false,
            tail_book: None,
        }
    }

    #[test]
    fn a_multi_hop_usage_bills_the_sum_and_measures_the_context_on_the_first_hop() {
        let usage = Usage {
            input_tokens: 1000,
            output_tokens: 50,
            cache_read_tokens: 900,
            raw: Some(json!({ "initialPromptTokenCount": 300, "initialCachedContentTokenCount": 400 })),
            ..Usage::default()
        };
        let row = usage_delta("s", &report(usage), 5);
        assert_eq!((&row["deltaInput"], &row["deltaPrompt"], &row["deltaCachedRead"]), (&json!(1000), &json!(1000), &json!(900)));
        assert_eq!((&row["contextInputTokens"], &row["contextPromptTokens"], &row["contextCachedReadTokens"]), (&json!(300), &json!(300), &json!(300)));
    }

    /// A record of a whole turn bills the turn's sum; the context it shows is the occupancy the provider measured.
    #[test]
    fn a_turns_usage_bills_the_sum_and_shows_the_measured_occupancy_as_the_context() {
        let usage = Usage {
            input_tokens: 1000,
            cache_read_tokens: 900,
            raw: Some(json!({ "input_tokens_known": true, "input_tokens_scope": "turn", "context_tokens": 240 })),
            ..Usage::default()
        };
        let row = usage_delta("s", &report(usage), 5);
        assert_eq!((&row["deltaInput"], &row["deltaPrompt"], &row["deltaCachedRead"]), (&json!(1000), &json!(1000), &json!(900)));
        assert_eq!((&row["contextInputTokens"], &row["contextPromptTokens"], &row["contextCachedReadTokens"]), (&json!(0), &json!(240), &json!(0)));
        assert_eq!(row["contextMeasuredTokens"], json!(240));
    }

    #[test]
    fn a_single_hop_usage_measures_the_context_on_what_was_billed() {
        let usage = Usage { input_tokens: 1000, cache_read_tokens: 900, raw: Some(json!({ "initialPromptTokenCount": 1000 })), ..Usage::default() };
        let row = usage_delta("s", &report(usage), 5);
        assert_eq!((&row["contextInputTokens"], &row["contextPromptTokens"], &row["contextCachedReadTokens"]), (&json!(1000), &json!(1000), &json!(900)));
    }

    #[test]
    fn notices_read_as_nodes_polish() {
        for (raw, want) in [
            ("✓ done", "done"),
            ("Error: could not reach the server: timeout", "Couldn’t reach the server: timeout"),
            ("model switch failed", "Couldn’t switch model."),
            ("theme save failed: disk full", "Couldn’t save theme: disk full"),
            ("compact already in progress.", "Compact context is already running."),
            ("A key is required for sync", "A key required for sync."),
            ("tool x left out of the request", "tool x left out of the request"),
            ("   ", ""),
        ] {
            assert_eq!(polish_notice_text(raw), want, "{raw}");
        }
    }

    #[test]
    fn the_marker_label_follows_status_and_trigger() {
        let event = |failed: bool, changed: bool, trigger: CompactTrigger| CompactEvent {
            dropped_count: 0,
            dropped: None,
            trigger,
            status: if failed {
                CompactStatus::Failed
            } else if changed {
                CompactStatus::Compacted
            } else {
                CompactStatus::NoChange
            },
            before_tokens: 0,
            duration_ms: 0,
            after_tokens: 0,
            before_messages: 0,
            after_messages: 0,
            pressure_tokens: 0,
            trigger_tokens: 0,
            boundary_tokens: 0,
            target_budget_tokens: 0,
        };
        assert_eq!(compact_event_label(&event(false, true, CompactTrigger::Auto)), "Compact complete");
        assert_eq!(compact_event_label(&event(false, true, CompactTrigger::Reactive)), "Compact complete (overflow recovery)");
        assert_eq!(compact_event_label(&event(true, false, CompactTrigger::Reactive)), "Compact failed (overflow retry)");
        assert_eq!(compact_event_label(&event(false, false, CompactTrigger::Auto)), "Compact checked");
        assert!(!compact_changed(&event(true, false, CompactTrigger::Auto)));
        let skipped = CompactEvent { status: CompactStatus::Skipped, ..event(false, false, CompactTrigger::Auto) };
        assert_eq!(compact_event_label(&skipped), "Compact skipped");
        assert!(!compact_changed(&skipped));
    }
}

/// The delta `accumulateCompactUsage` reports for a compaction pass's summary (`pre-send-compact.mjs`), key for key:
/// no request facts, the source `fresh_context_compact`. The turn and epoch are the session's (`usage_books`).
pub(crate) fn compact_usage_delta(session_id: &str, report: &super::run::CompactUsageReport, ts: i64) -> Value {
    let usage = &report.usage;
    json!({
        "sessionId": session_id,
        "iterationIndex": report.iteration,
        "deltaInput": usage.input_tokens,
        "deltaOutput": usage.output_tokens,
        "reasoningTokens": report.reasoning_tokens,
        "reasoningTokensComplete": report.reasoning_tokens_complete,
        "deltaCachedRead": usage.cache_read_tokens,
        "deltaCacheWrite": usage.cache_write_tokens,
        "source": "fresh_context_compact",
        "ts": ts,
    })
}
// A long-decode turn bills every hop, but the context holds only the first hop's prompt plus what was generated
// (`normalizeGeminiUsage`'s `contextInputTokens` / `contextCachedTokens`): the billing delta keeps the summed counts and the
// context figures take the first hop's, which the provider's usage carries as `initialPromptTokenCount`.
fn first_hop_context(usage: &Usage, delta_prompt: u64) -> (Usage, u64) {
    let mut context = usage.clone();
    let mut context_prompt = delta_prompt;
    // A record of a whole turn counts every model call of it: the context it shows is the occupancy the provider
    // measured, and no prompt.
    if mixdog_agent::compact::pressure::counts_a_turn(usage) {
        context.input_tokens = 0;
        context.cache_read_tokens = 0;
        return (context, mixdog_agent::compact::pressure::measured_context_tokens(usage).unwrap_or(0));
    }
    if let Some((initial, cached)) = mixdog_agent::compact::pressure::first_hop(usage) {
        context.input_tokens = initial;
        context_prompt = initial;
        context.cache_read_tokens = cached;
    }
    (context, context_prompt)
}

pub(crate) fn usage_delta(session_id: &str, report: &super::run::UsageReport, ts: i64) -> Value {
    let usage = &report.usage;
    let tools: Vec<Value> = report
        .send_tools
        .iter()
        .map(|tool| {
            let mut out = json!({ "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema });
            if tool.defer_loading {
                out["deferLoading"] = Value::Bool(true);
            }
            out
        })
        .collect();
    let (context, context_prompt) = first_hop_context(usage, report.delta_prompt);
    json!({
        "sessionId": session_id,
        "iterationIndex": report.iteration,
        "source": "provider_send",
        "requestedModel": report.requested_model,
        "model": report.model,
        "deltaInput": usage.input_tokens,
        "deltaOutput": usage.output_tokens,
        "deltaToolCalls": report.delta_tool_calls,
        "reasoningTokens": report.reasoning_tokens,
        "reasoningTokensComplete": report.reasoning_tokens_complete,
        "deltaPrompt": report.delta_prompt,
        "requestMs": report.request_ms,
        "promptKnown": true,
        "deltaCachedRead": usage.cache_read_tokens,
        "deltaCacheWrite": usage.cache_write_tokens,
        "contextInputTokens": context.input_tokens,
        "contextOutputTokens": usage.output_tokens,
        "contextPromptTokens": context_prompt,
        "contextCachedReadTokens": context.cache_read_tokens,
        "contextCacheWriteTokens": usage.cache_write_tokens,
        "contextMeasuredTokens": mixdog_agent::compact::pressure::measured_context_tokens(&context),
        "sendTools": tools,
        "ts": ts,
    })
}
