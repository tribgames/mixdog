//! The texts of a turn's live-only rows and notifications: notice polish
//! (`tui/session/notice-text.mjs`), the compact marker (`compact-event-label.mjs`,
//! `tui/session/labels.mjs`) and the usage delta (`loop/usage.mjs` `usageDeltaEvent`).

use std::sync::LazyLock;

use mixdog_agent::env::CompactEvent;
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
    if event.failed {
        "failed"
    } else if event.changed {
        "compacted"
    } else {
        "no_change"
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

fn fmt_tok(n: f64) -> String {
    if n >= 1000.0 {
        let k = n / 1000.0;
        if n >= 10_000.0 { format!("{k:.0}") + "k" } else { format!("{k:.1}") + "k" }
    } else {
        format!("{}", n.round())
    }
}

/// `compactEventDetail(event)`: the event carries no duration (`0s`) and no after-count, so
/// the token part never shows.
pub(crate) fn compact_event_detail(event: &CompactEvent) -> String {
    let mut parts = vec!["0s".to_owned()];
    let before = event.pressure_tokens as f64;
    let after = 0.0;
    if before > 0.0 && after > 0.0 && after != before {
        parts.push(format!("{}→{}", fmt_tok(before), fmt_tok(after)));
    }
    parts.join(" · ")
}

/// `usageDeltaEvent` of one model call, with the fields the call reports here.
pub(crate) fn usage_delta(session_id: &str, iteration: u32, usage: &Usage, ts: i64) -> Value {
    json!({
        "sessionId": session_id,
        "iterationIndex": iteration,
        "source": "provider_send",
        "deltaInput": usage.input_tokens,
        "deltaOutput": usage.output_tokens,
        "deltaCachedRead": usage.cache_read_tokens,
        "deltaCacheWrite": usage.cache_write_tokens,
        "contextInputTokens": usage.input_tokens,
        "contextOutputTokens": usage.output_tokens,
        "contextCachedReadTokens": usage.cache_read_tokens,
        "contextCacheWriteTokens": usage.cache_write_tokens,
        "ts": ts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
            changed,
            failed,
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
        assert_eq!(compact_event_detail(&event(false, true, CompactTrigger::Auto)), "0s");
        assert!(!compact_changed(&event(true, false, CompactTrigger::Auto)));
    }
}
