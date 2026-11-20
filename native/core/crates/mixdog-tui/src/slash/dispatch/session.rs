//! Slash commands that act on the session itself: clear/new, compact, btw, goal, resume, fork (alias inherit), shells, stop,
//! doctor and quit (`slash-dispatch/session-commands.mjs`). Busy guards refuse the destructive ones while a turn or a session
//! command is running.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, js_words, value_to_string};
use mixdog_view_model::errors::err_text::{PresentOptions, present_error_text};
use mixdog_view_model::errors::js_value::ERROR_INSTANCE_KEY;
use serde_json::{Map, Value, json};

use super::report_failure;
use super::slash_panel::open_slash_panel;
use crate::slash::host::{Opener, SlashHost, Tone};
use crate::slash::notices::{truthy, value_text};
use crate::surface::{SurfaceClaim, SurfaceKind};

/// The hint `/btw` answers with when it has no question (`BTW_USAGE_HINT`).
pub const BTW_USAGE_HINT: &str = "usage: /btw <question>";

/// The item value of the `/stop` confirmation that leaves everything running.
pub const STOP_CANCEL: &str = "cancel";
/// The item value of the `/stop` confirmation that stops the shells.
pub const STOP_CONFIRM: &str = "stop";

pub(super) fn handler(name: &str) -> Option<super::Handler> {
    let handler: super::Handler = match name {
        "clear" => |host, _, raw| clear(host, raw),
        "compact" => |host, _, _| compact(host),
        "btw" => |host, arg, _| btw(host, arg),
        "goal" => |host, arg, _| goal(host, arg),
        "resume" => |host, arg, _| resume(host, arg),
        "fork" => |host, _, raw| fork(host, raw),
        "shells" => |host, arg, _| shells(host, arg),
        "stop" => |host, _, _| stop(host),
        "doctor" => |host, _, _| doctor(host),
        "quit" => |host, _, _| quit(host),
        _ => return None,
    };
    Some(handler)
}

/// An error value the way a caught `Error` reaches `presentErrorText`.
fn error_value(message: &str) -> Value {
    let mut error = Map::new();
    error.insert(ERROR_INSTANCE_KEY.to_owned(), Value::Bool(true));
    error.insert("message".to_owned(), Value::String(message.to_owned()));
    Value::Object(error)
}

fn compact_failure_notice(error: &Value) -> String {
    if error.is_null() || js_trim(&value_to_string(error)).is_empty() {
        return "Compact failed.".to_owned();
    }
    let options = PresentOptions { surface: "compact", max: Some(320.0), ..PresentOptions::default() };
    let reason = present_error_text(Some(error), &options);
    if reason.is_empty() || reason == "Unknown error" {
        return "Compact failed.".to_owned();
    }
    static ALREADY_FAILED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^compact(?:ion)? failed\b", "i"));
    if ALREADY_FAILED.is_match(&reason) { reason } else { format!("Compact failed: {reason}") }
}

fn compact_outcome_notice(result: &Value) -> (String, Tone) {
    if !truthy(result) {
        return ("Compact failed.".to_owned(), Tone::Warn);
    }
    if let Some(error) = result.get("error").filter(|error| truthy(error)) {
        return (compact_failure_notice(error), Tone::Error);
    }
    if result.get("changed") == Some(&Value::Bool(false)) {
        return match result.get("reason").filter(|reason| truthy(reason)) {
            Some(reason) => (value_text(reason), Tone::Warn),
            None => ("nothing to compact".to_owned(), Tone::Warn),
        };
    }
    ("Compact done.".to_owned(), Tone::Info)
}

fn refuse_while_busy(host: &mut dyn SlashHost, command: &str) -> bool {
    host.push_notice(&format!("wait for the current turn to finish before /{command}"), Tone::Warn);
    false
}

fn clear(host: &mut dyn SlashHost, raw_name: &str) -> bool {
    let state = host.state();
    let is_new = raw_name == "new";
    if state.busy || state.command_busy {
        host.push_notice(&format!("wait for the current session command to finish before /{}", if is_new { "new" } else { "clear" }), Tone::Warn);
        return false;
    }
    if is_new {
        match host.store_call("newSession", json!([])) {
            Ok(Value::Bool(false)) => host.push_notice("new session is already running", Tone::Warn),
            // Incremental rendering can otherwise retain physical rows from the taller outgoing transcript on Windows Terminal.
            Ok(_) => host.force_render_repaint(),
            Err(error) => report_failure(host, "new session failed", &error),
        }
    } else if let Err(error) = host.store_call("clear", json!([])) {
        report_failure(host, "clear failed", &error);
    }
    true
}

fn compact(host: &mut dyn SlashHost) -> bool {
    if host.state().busy {
        return refuse_while_busy(host, "compact");
    }
    match host.store_call("compact", json!([])) {
        Ok(result) => {
            let (text, tone) = compact_outcome_notice(&result);
            host.push_notice(&text, tone);
        }
        Err(error) => host.push_notice(&compact_failure_notice(&error_value(&error)), Tone::Error),
    }
    true
}

/// A side question: allowed mid-turn; never queued, steered, or interrupting.
fn btw(host: &mut dyn SlashHost, arg: &str) -> bool {
    let question = js_trim(arg);
    if question.is_empty() {
        host.push_notice(BTW_USAGE_HINT, Tone::Warn);
        return true;
    }
    host.btw_ask(question);
    true
}

fn goal(host: &mut dyn SlashHost, arg: &str) -> bool {
    match host.store_call("goalControl", json!([{"command": arg}])) {
        Ok(result) if truthy(&result) => {
            let message = result.get("message").filter(|message| truthy(message)).map_or_else(|| "Goal updated.".to_owned(), value_text);
            let tone = if result.get("ok") == Some(&Value::Bool(false)) { Tone::Warn } else { Tone::Info };
            host.push_notice(&message, tone);
        }
        Ok(_) => host.push_notice("Goal is unavailable.", Tone::Warn),
        Err(error) => report_failure(host, "Goal failed", &error),
    }
    true
}

fn resume(host: &mut dyn SlashHost, arg: &str) -> bool {
    if host.state().busy {
        return refuse_while_busy(host, "resume");
    }
    if arg.is_empty() {
        open_slash_panel(host, "resume", "Resume", Opener::Resume, json!({}));
        return true;
    }
    match host.store_call("resume", json!([arg])) {
        Ok(result) if truthy(&result) => host.push_notice(&format!("Resumed {arg}"), Tone::Info),
        Ok(_) => host.push_notice("Couldn\u{2019}t resume chat.", Tone::Warn),
        Err(error) => report_failure(host, "Couldn\u{2019}t resume chat", &error),
    }
    true
}

fn fork(host: &mut dyn SlashHost, raw_name: &str) -> bool {
    if host.state().busy {
        return refuse_while_busy(host, if raw_name == "inherit" { "inherit" } else { "fork" });
    }
    match host.store_call("inheritSession", json!([])) {
        Ok(result) if truthy(&result) => {
            let field = |key: &str| result.get(key).map(value_to_string).unwrap_or_else(|| "undefined".to_owned());
            host.push_notice(&format!("forked {} messages into {}", field("messages"), field("sessionId")), Tone::Info);
        }
        Ok(_) => host.push_notice("nothing to fork", Tone::Warn),
        Err(error) => report_failure(host, "fork failed", &error),
    }
    true
}

fn job_jobs(result: &Value) -> Vec<Value> {
    result.get("jobs").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn job_text(job: &Value, key: &str) -> String {
    job.get(key).map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `/shells`: this session's shells, each marked running or "termination unconfirmed". `/shells release <id>` explains what
/// releasing means and asks for `--confirm`; only then is the workspace hold dropped.
fn shells(host: &mut dyn SlashHost, arg: &str) -> bool {
    let mut words = js_words(arg);
    let (action, task_id, flag) = (words.next(), words.next(), words.next());
    let Some(action) = action else {
        match host.store_call("listShellJobs", json!([])) {
            Ok(result) => {
                let jobs = job_jobs(&result);
                if jobs.is_empty() {
                    host.push_notice("No shells are running.", Tone::Info);
                    return true;
                }
                let held_of = |job: &Value| job.get("terminationUnconfirmed").is_some_and(truthy);
                let mut lines: Vec<String> = jobs
                    .iter()
                    .map(|job| {
                        let state = if held_of(job) { "termination unconfirmed" } else { "running" };
                        format!("{}  {state}  {}", job_text(job, "taskId"), job_text(job, "command"))
                    })
                    .collect();
                let held = jobs.iter().any(held_of);
                if held {
                    lines.push("Release a held shell with /shells release <task_id>.".to_owned());
                }
                host.push_notice(&lines.join("\n"), if held { Tone::Warn } else { Tone::Info });
            }
            Err(error) => report_failure(host, "Couldn\u{2019}t list shells", &error),
        }
        return true;
    };
    let Some(task_id) = task_id.filter(|_| action == "release") else {
        host.push_notice("usage: /shells [release <task_id> [--confirm]]", Tone::Warn);
        return true;
    };
    if flag != Some("--confirm") {
        host.push_notice(
            &format!("Releasing {task_id} unlocks its folder although its processes may still be running. To proceed, run /shells release {task_id} --confirm"),
            Tone::Warn,
        );
        return true;
    }
    match host.store_call("releaseShellJob", json!([task_id])) {
        Ok(result) if result.get("released").is_some_and(truthy) => {
            host.push_notice(&format!("Released {task_id}."), Tone::Info);
        }
        Ok(result) => {
            let reason = result.get("error").filter(|error| truthy(error)).map_or_else(|| "unavailable".to_owned(), value_text);
            host.push_notice(&format!("Couldn\u{2019}t release {task_id}: {reason}"), Tone::Warn);
        }
        Err(error) => report_failure(host, &format!("Couldn\u{2019}t release {task_id}"), &error),
    }
    true
}

fn stop_all(host: &mut dyn SlashHost) {
    match host.store_call("stopShellJobs", json!([])) {
        Ok(result) => {
            let count = |key: &str| result.get(key).filter(|value| truthy(value)).map_or(0.0, |value| mixdog_js::to_number(value));
            let (stopped, stopping) = (count("stopped"), count("stopping"));
            let text = if stopping != 0.0 {
                format!("Stopped background shells: {} \u{b7} still stopping: {}", mixdog_js::number_to_string(stopped), mixdog_js::number_to_string(stopping))
            } else {
                format!("Stopped background shells: {}", mixdog_js::number_to_string(stopped))
            };
            host.push_notice(&text, if stopping != 0.0 { Tone::Warn } else { Tone::Info });
        }
        Err(error) => host.push_notice(&error, Tone::Error),
    }
}

/// `/stop`: stop every background shell of this session (never the running foreground command, agents or other sessions)
/// after one confirmation.
fn stop(host: &mut dyn SlashHost) -> bool {
    match host.store_call("listStoppableShellJobs", json!([])) {
        Ok(result) => {
            let jobs = job_jobs(&result);
            if jobs.is_empty() {
                host.push_notice("No background shells are running.", Tone::Info);
                return true;
            }
            let claim = host.claim_surface(SurfaceKind::Picker);
            let commands: Vec<String> = jobs.iter().map(|job| job_text(job, "command")).collect();
            host.paint_stop_confirm(claim, &format!("Stop background shells ({})?", jobs.len()), &commands);
        }
        Err(error) => host.push_notice(&error, Tone::Error),
    }
    true
}

/// The `/stop` confirmation was answered with an item (`onSelect(value)`): the prompt closes, and the shells stop only for
/// [`STOP_CONFIRM`].
pub fn stop_prompt_select(host: &mut dyn SlashHost, claim: SurfaceClaim, value: &str) {
    host.close_surface(claim);
    if value == STOP_CONFIRM {
        stop_all(host);
    }
}

/// The `/stop` confirmation was cancelled (`onCancel`): the prompt closes and nothing is stopped.
pub fn stop_prompt_cancel(host: &mut dyn SlashHost, claim: SurfaceClaim) {
    host.close_surface(claim);
}

fn doctor(host: &mut dyn SlashHost) -> bool {
    if host.state().command_busy {
        host.push_notice("wait for the current command to finish before /doctor", Tone::Warn);
        return false;
    }
    if let Err(error) = host.run_doctor() {
        report_failure(host, "doctor failed", &error);
    }
    true
}

fn quit(host: &mut dyn SlashHost) -> bool {
    host.request_exit();
    true
}
