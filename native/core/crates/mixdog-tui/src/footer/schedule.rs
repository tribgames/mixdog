//! `components/status-line/boot-schedule.mjs`: the footer's timings and the detection of active work that sets them.
//!
//! Node also loaded `ui/statusline.mjs` lazily and retried a failed import with a doubling backoff; the render here is
//! compiled in, so there is no import to prewarm, to fail or to retry, and the first full render keeps only the boot delay.

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_tui_style::color::strip_ansi;
use serde_json::Value;

use crate::slash::notices::first_truthy_text;

/// The wait before a full render starts after an input changed (a later change restarts it).
pub const STATUSLINE_RENDER_DEBOUNCE_MS: f64 = 150.0;
/// The shortest wait before a timer that re-arms the effect fires.
pub const STATUSLINE_RETRY_FLOOR_MS: f64 = 150.0;
const STATUSLINE_BOOT_FULL_DELAY_MS: f64 = 1000.0;
const STATUSLINE_BOOT_FULL_DELAY_ACTIVE_MS: f64 = 2200.0;
/// The refresh period while nothing runs.
pub const STATUSLINE_REFRESH_MS: f64 = 2000.0;
/// The refresh period while agents, shells or a web search run.
pub const STATUSLINE_ACTIVE_REFRESH_MS: f64 = 500.0;

/// `String(a || b || ... || '')` over the named fields of a worker or job.
pub(crate) fn first_text(value: &Value, keys: &[&str]) -> String {
    first_truthy_text(value, keys).unwrap_or_default()
}

/// `isTerminalStatus(statusText)`: a status that names an ending.
pub fn is_terminal_status(status: &str) -> bool {
    let status = js_to_lowercase(status);
    ["idle", "done", "complete", "success", "closed", "error", "fail", "cancel", "killed", "timeout"].iter().any(|word| status.contains(word))
}

fn has_running_workers(workers: &[Value], jobs: &[Value]) -> bool {
    let worker_runs = workers.iter().any(|worker| {
        let tag = first_text(worker, &["tag", "agent", "name"]);
        !js_trim(&tag).is_empty() && !is_terminal_status(&first_text(worker, &["stage", "status"]))
    });
    worker_runs || jobs.iter().any(|job| js_to_lowercase(&first_text(job, &["status", "stage"])).contains("running"))
}

fn has_active_tools(active_tools: Option<&Value>) -> bool {
    active_tools
        .filter(|tools| tools.is_object())
        .and_then(|tools| tools.get("web_search"))
        .and_then(|search| search.get("count"))
        .is_some_and(|count| mixdog_js::to_number(count) > 0.0)
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Whether `\b<word>\b` matches in `text` (the word starts and ends with a word character).
fn has_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(at, _)| !is_word(text[..at].chars().next_back()) && !is_word(text[at + word.len()..].chars().next()))
}

/// Whether `\bRunning \d+ (?:Agents?|Shells?)\b` matches in `text`.
fn has_running_count(text: &str) -> bool {
    text.match_indices("Running ").any(|(at, _)| {
        if is_word(text[..at].chars().next_back()) {
            return false;
        }
        let rest = &text[at + "Running ".len()..];
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        let rest = rest[digits..].strip_prefix(' ');
        rest.is_some_and(|rest| {
            ["Agent", "Shell"].iter().any(|noun| {
                rest.strip_prefix(noun)
                    .is_some_and(|after| !is_word(after.chars().next()) || after.strip_prefix('s').is_some_and(|after_s| !is_word(after_s.chars().next())))
            })
        })
    })
}

/// `hasActiveStatuslineWork(line, workers, jobs, activeTools)`: something runs, by the inputs or by what the line says.
pub fn has_active_statusline_work(line: &str, workers: &[Value], jobs: &[Value], active_tools: Option<&Value>) -> bool {
    if has_running_workers(workers, jobs) || has_active_tools(active_tools) {
        return true;
    }
    let plain = strip_ansi(line);
    has_running_count(&plain) || ["Exploring", "Searching", "Memory"].iter().any(|word| has_word(&plain, word))
}

/// `bootFullRenderDelayRemainingMs(mountAt, line, workers, jobs, activeTools)`: the milliseconds left before the boot full
/// render may run (zero or less once eligible); the delay is longer while agents, shells or tools are active.
pub fn boot_full_render_delay_remaining_ms(mount_at_ms: f64, now: f64, line: &str, workers: &[Value], jobs: &[Value], active_tools: Option<&Value>) -> f64 {
    let active = has_active_statusline_work(line, workers, jobs, active_tools);
    let delay = if active { STATUSLINE_BOOT_FULL_DELAY_ACTIVE_MS } else { STATUSLINE_BOOT_FULL_DELAY_MS };
    delay - (now - mount_at_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_status_that_names_an_ending_is_terminal() {
        for status in ["idle", "Done", "completed", "success", "closed", "error", "failed", "cancelled", "killed", "timeout"] {
            assert!(is_terminal_status(status), "{status}");
        }
        assert!(!is_terminal_status("running") && !is_terminal_status(""));
    }

    #[test]
    fn running_workers_and_jobs_and_searches_are_active_work() {
        let none: [Value; 0] = [];
        assert!(has_active_statusline_work("", &[json!({ "tag": "a", "stage": "running" })], &none, None));
        assert!(!has_active_statusline_work("", &[json!({ "tag": "a", "status": "idle" }), json!({ "stage": "running" })], &none, None));
        assert!(has_active_statusline_work("", &none, &[json!({ "status": "Running" })], None));
        assert!(has_active_statusline_work("", &none, &none, Some(&json!({ "web_search": { "count": 1 } }))));
        assert!(!has_active_statusline_work("", &none, &none, Some(&json!({ "web_search": { "count": 0 } }))));
    }

    #[test]
    fn the_line_itself_says_what_runs() {
        let none: [Value; 0] = [];
        let said = |line: &str| has_active_statusline_work(line, &none, &none, None);
        assert!(said("\u{1b}[32m\u{280b}\u{1b}[0m Running 2 Agents"));
        assert!(said("x Running 1 Shell \u{b7} 3s"));
        assert!(said("a Memory \u{b7} 12s") && said("Searching") && said("Exploring files"));
        assert!(!said("Running Agents") && !said("Running 2 Agentsx") && !said("preRunning 2 Agents") && !said("Memorys") && !said("model"));
    }

    #[test]
    fn the_boot_delay_is_longer_while_work_is_active() {
        let none: [Value; 0] = [];
        assert_eq!(boot_full_render_delay_remaining_ms(1000.0, 1300.0, "", &none, &none, None), 700.0);
        assert_eq!(boot_full_render_delay_remaining_ms(1000.0, 1300.0, "Running 1 Agent", &none, &none, None), 1900.0);
        assert!(boot_full_render_delay_remaining_ms(1000.0, 2000.0, "", &none, &none, None) <= 0.0);
    }
}
