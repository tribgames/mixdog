//! The pure formatting helpers of the application shell (`src/tui/app/app-format.mjs`): the centred lines of the welcome
//! banner, the tool approval text, the starter tips of the welcome screen and the provider-setup test behind the "no
//! provider" tip. The provider row labels, the session labels and the workflow notices of the same Node module live with
//! their pickers ([`crate::pickers`], [`crate::slash::notices`]); the hint colour of a tone is
//! [`mixdog_tui_widgets::hint_overprint::prompt_status_key`].

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};

use mixdog_js::{json_stringify, slice_utf16, value_to_string};
use mixdog_termtext::{StringWidthOptions, string_width};
use mixdog_tui_widgets::hint_overprint::clean_right_message;
use mixdog_view_model::display::clean::clean;
use mixdog_view_model::tool_surface::format_tool_surface_default;
use serde_json::Value;

use crate::pickers::provider::format::provider_row_usable;

/// `stringWidth(text)` of the `string-width` package (ambiguous characters narrow), which the Node helpers measure with.
fn text_width(text: &str) -> usize {
    string_width(text, StringWidthOptions::default())
}

/// `Math.max(1, Number(columns || 80) - reserve)`.
fn available_width(columns: usize, reserve: usize) -> usize {
    let columns = if columns == 0 { 80 } else { columns };
    columns.saturating_sub(reserve).max(1)
}

/// `fitLine(value, columns, reserve)`: the text as it is when it fits, otherwise cut by whole characters with a closing `…`.
pub fn fit_line(value: &str, columns: usize, reserve: usize) -> String {
    let width = available_width(columns, reserve);
    if text_width(value) <= width {
        return value.to_owned();
    }
    if width <= 1 {
        return "\u{2026}".repeat(width);
    }
    let mut out = String::new();
    for ch in value.chars() {
        let mut probe = out.clone();
        probe.push(ch);
        probe.push('\u{2026}');
        if text_width(&probe) > width {
            break;
        }
        out.push(ch);
    }
    out.push('\u{2026}');
    out
}

/// `centerLine(value, columns, reserve)`: the fitted text with the blanks that centre it in `columns - reserve` cells.
pub fn center_line(value: &str, columns: usize, reserve: usize) -> String {
    let text = fit_line(value, columns, reserve);
    let width = available_width(columns, reserve);
    let pad = width.saturating_sub(text_width(&text)) / 2;
    format!("{}{text}", " ".repeat(pad))
}

/// `compactJson(value, max)`: the value as one line of at most `max` cells (`None` is an absent value: nothing).
fn compact_json(value: Option<&Value>, max: usize) -> String {
    let text = match value {
        None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(value) => json_stringify(value),
    };
    let text = clean_right_message(&text);
    if text.is_empty() {
        return text;
    }
    if text_width(&text) > max {
        return format!("{}\u{2026}", slice_utf16(&text, max.saturating_sub(1).max(1)));
    }
    text
}

/// `${value}` of a template literal over an optional JSON value.
fn template_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(value) => value_to_string(value),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `toolApprovalDescription(request)`: the lines of the tool approval panel (the tool and what it is about, the reason the
/// hook gave, the arguments in one line).
pub fn tool_approval_description(request: &Value) -> String {
    let name = request.get("name");
    let name_text = if truthy(name) { name.map(value_to_string).unwrap_or_default() } else { String::new() };
    let surface = format_tool_surface_default(&name_text, request.get("args").unwrap_or(&Value::Null));
    let summary = if !surface.summary.is_empty() {
        let label = if surface.label.is_empty() { template_text(name) } else { surface.label.clone() };
        format!("{label} ({})", surface.summary)
    } else if !surface.label.is_empty() {
        surface.label.clone()
    } else if !name_text.is_empty() {
        name_text
    } else {
        "tool".to_owned()
    };
    let reason = clean(request.get("reason"));
    let reason = if reason.is_empty() { "Hook requested approval.".to_owned() } else { reason };
    let args = compact_json(request.get("args"), 180);
    [format!("Tool: {summary}"), format!("Reason: {reason}"), if args.is_empty() { String::new() } else { format!("Args: {args}") }]
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The starter tips of the empty transcript, one of which is pinned for the process.
pub const WELCOME_PROMPT_HINTS: [&str; 20] = [
    "Tip: /setting \u{b7} Tune the runtime before the run.",
    "Tip: /model \u{b7} Pick the right brain for the job.",
    "Tip: /workflow \u{b7} Change how work gets routed.",
    "Tip: Ctrl+O \u{b7} Expand tool output when you need details.",
    "Tip: PageUp/PageDown \u{b7} Scroll the transcript.",
    "Tip: Esc \u{b7} Close panels or interrupt work.",
    "Tip: /usage \u{b7} Check quota before a long run.",
    "Tip: /agents \u{b7} See who can help.",
    "Tip: /theme \u{b7} Change the terminal mood.",
    "Tip: /websearch \u{b7} Set web search routing.",
    "Paste an error. I\u{2019}ll trace it.",
    "Tell me the goal. I\u{2019}ll handle the steps.",
    "Start with a task, a bug, or a wild idea.",
    "Good fixes start with a repro.",
    "Ask for a plan, then let the agents work.",
    "Small prompt, sharp result.",
    "Drop in a file path and ask what changed.",
    "Describe the outcome, not just the command.",
    "Ready when you are.",
    "One clear goal beats ten vague tasks.",
];

/// The tips that replace the starter tip when the setup has a problem.
pub mod conditional_hints {
    pub const NO_PROVIDER: &str = "Tip: /providers \u{b7} Connect a provider before your first turn.";
    pub const NO_MODEL: &str = "Tip: /model \u{b7} Choose a model before your first turn.";
    pub const SOLO_WORKFLOW: &str = "Tip: /workflow \u{b7} Switch from Solo when you want agents.";
    pub const WEB_SEARCH_DEFAULT_UNSUPPORTED: &str = "Tip: /websearch \u{b7} Choose a native web-search model for this main model.";
    pub const ERROR: &str = "Tip: /doctor \u{b7} Check setup health.";
}

/// `randomWelcomePromptHint()`: one of the starter tips, picked with the randomness the standard library seeds per process.
pub fn random_welcome_prompt_hint() -> &'static str {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u8(0);
    WELCOME_PROMPT_HINTS[(hasher.finish() % WELCOME_PROMPT_HINTS.len() as u64) as usize]
}

/// `providerSetupHasUsableProvider(setup)`: some row of the API, OAuth or local lists is usable.
pub fn provider_setup_has_usable_provider(setup: &Value) -> bool {
    ["api", "oauth", "local"].into_iter().filter_map(|list| setup.get(list).and_then(Value::as_array)).flatten().any(provider_row_usable)
}

/// `terminalSize(stdout)`: the columns and rows the terminal reports, where a zero (a terminal that has not told its size
/// yet) is not a size: it is 80 by 24 so the first frame is not laid out against a collapsed viewport.
pub fn terminal_size(columns: usize, rows: usize) -> (usize, usize) {
    if columns > 0 && rows > 0 {
        return (columns, rows);
    }
    (if columns > 0 { columns } else { 80 }, if rows > 0 { rows } else { 24 })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_line_that_fits_is_centred_and_a_long_one_is_cut_with_an_ellipsis() {
        assert_eq!(center_line("abcd", 10, 0), "   abcd");
        assert_eq!(fit_line("abcdefgh", 6, 0), "abcde\u{2026}");
        assert_eq!(fit_line("abc", 3, 4), "\u{2026}");
        assert_eq!(fit_line("abc", 0, 0), "abc");
        // A wide character is not split: the last whole one that leaves room for the ellipsis stays.
        assert_eq!(fit_line("\u{d55c}\u{ae00}\u{d55c}\u{ae00}", 6, 0), "\u{d55c}\u{ae00}\u{2026}");
    }

    #[test]
    fn the_starter_tip_is_one_of_the_list_and_the_conditional_tips_are_distinct() {
        assert!(WELCOME_PROMPT_HINTS.contains(&random_welcome_prompt_hint()));
        let all = [
            conditional_hints::NO_PROVIDER,
            conditional_hints::NO_MODEL,
            conditional_hints::SOLO_WORKFLOW,
            conditional_hints::WEB_SEARCH_DEFAULT_UNSUPPORTED,
            conditional_hints::ERROR,
        ];
        assert!(all.iter().enumerate().all(|(at, tip)| all.iter().skip(at + 1).all(|other| other != tip)));
    }

    #[test]
    fn a_setup_is_usable_when_a_row_of_any_list_is() {
        assert!(!provider_setup_has_usable_provider(&json!({})));
        assert!(provider_setup_has_usable_provider(&json!({ "local": [{ "id": "l", "usable": true }] })));
        assert!(!provider_setup_has_usable_provider(&json!({ "oauth": [{ "usable": true, "reauthRequired": true }] })));
    }

    #[test]
    fn the_approval_text_names_the_tool_the_reason_and_the_arguments() {
        let text = tool_approval_description(&json!({ "name": "bash", "args": { "command": "ls" }, "reason": "  Needs a look.  " }));
        let lines: Vec<&str> = text.split('\n').collect();
        assert!(lines[0].starts_with("Tool: "));
        assert_eq!(lines[1], "Reason: Needs a look.");
        assert_eq!(lines[2], "Args: {\"command\":\"ls\"}");
        assert!(tool_approval_description(&json!({})).contains("Reason: Hook requested approval."));
        let long = tool_approval_description(&json!({ "name": "x", "args": "y".repeat(400) }));
        assert!(long.ends_with('\u{2026}'));
    }

    #[test]
    fn a_terminal_that_has_not_reported_its_size_is_eighty_by_twenty_four() {
        assert_eq!(terminal_size(0, 0), (80, 24));
        assert_eq!(terminal_size(100, 0), (100, 24));
        assert_eq!(terminal_size(100, 30), (100, 30));
    }
}
