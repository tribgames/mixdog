//! What Node answers for the exec helpers its own tests assert (`fixtures/tools-untested/exec-*.json`,
//! `record-tools-untested.mjs`), replayed whole and in the recorded order.

use super::benign::is_benign_search_exit_one;
use super::env::{ShellEnv, shell_env};
use super::hoist::{plan_long_inline_script_file_transport, plan_long_shell_script_file_transport};
use super::shell::{Args, PromotionReason, hold_end, hold_ms, promotes_at_timeout, time_limit_ms};
use serde_json::Value;
use std::path::Path;

fn recorded(text: &str) -> Value {
    serde_json::from_str(text).expect("recording")
}

#[test]
fn a_search_stage_with_exit_one_is_benign_as_node_decides() {
    let doc = recorded(mixdog_testkit::fixture!("../../fixtures/tools-untested/exec-benign.json"));
    let mut failures = Vec::new();
    for call in doc["calls"].as_array().unwrap() {
        let got = is_benign_search_exit_one(
            call["command"].as_str().unwrap(),
            call["exitCode"].as_i64().unwrap() as i32,
            call["signal"].is_string(),
            call["stderr"].as_str().unwrap(),
        );
        if got != call["benign"].as_bool().unwrap() {
            failures.push(format!("{} (exit {}, signal {}, stderr {}): Node {}, here {got}", call["command"], call["exitCode"], call["signal"], call["stderr"], call["benign"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn the_hold_and_the_run_limit_are_planned_as_node_plans_them() {
    let doc = recorded(mixdog_testkit::fixture!("../../fixtures/tools-untested/exec-deadline.json"));
    let mut failures = Vec::new();
    let mut compared = 0;
    for call in doc["calls"].as_array().unwrap() {
        let env = |name: &str| call["env"].get(name).and_then(Value::as_str).map(str::to_owned);
        let enabled = call["backgroundOnTimeout"].as_bool().unwrap();
        // The plan reads only the timing arguments; the command is no input to it.
        let mut given = call["args"].clone();
        given["command"] = Value::from("");
        let args: Args = serde_json::from_value(given).unwrap();
        let limit = time_limit_ms(&args, enabled, &env);
        let hold = hold_ms(&args, limit, enabled, &env);
        let plan = &call["plan"];
        let promote = promotes_at_timeout(enabled, limit, hold, &env);
        let got = [("autoBackgroundMs", hold, plan["autoBackgroundMs"].as_u64().unwrap()), ("backgroundDeadlineMs", limit, plan["backgroundDeadlineMs"].as_u64().unwrap())];
        for (what, here, node) in got {
            if here != node {
                failures.push(format!("{what} for {} {} (background {enabled}): Node {node}, here {here}", call["env"], call["args"]));
            }
        }
        if promote != plan["promoteAtTimeout"].as_bool().unwrap() {
            failures.push(format!("promoteAtTimeout for {} {} (background {enabled}): Node {}, here {promote}", call["env"], call["args"], plan["promoteAtTimeout"]));
        }
        // The hold's own timer as Node armed it (`armed`, the `autoBackground` entries): there exactly when the hold ends by
        // promoting, and due at the hold. The limit's timer (`timeout`) carries Node's `timeout`, which is not compared (manifest).
        let node_hold_timer: Vec<u64> =
            call["armed"].as_array().unwrap().iter().filter(|timer| timer["timer"] == "autoBackground").map(|timer| timer["delay"].as_u64().unwrap()).collect();
        let promotes = enabled && hold > 0 && matches!(hold_end(call["args"]["background"] == true, limit, hold, &env), Some(PromotionReason::Background | PromotionReason::Threshold));
        let here_hold_timer: Vec<u64> = if promotes { vec![hold] } else { Vec::new() };
        if here_hold_timer != node_hold_timer {
            failures.push(format!("the hold's timer for {} {} (background {enabled}): Node {node_hold_timer:?}, here {here_hold_timer:?}", call["env"], call["args"]));
        }
        // What the end of the hold does is decided by `hold_end`, the function the shell run waits and words its promotion by.
        // A call with no hold never reaches that decision.
        if enabled && hold > 0 {
            let got = match hold_end(call["args"]["background"] == true, limit, hold, &env) {
                None => "enforce",
                Some(PromotionReason::Background) => "background",
                Some(PromotionReason::Threshold) => "threshold",
                Some(PromotionReason::Timeout) => "timeout",
                Some(_) => "other",
            };
            if got != call["holdEnd"].as_str().unwrap() {
                failures.push(format!("end of the hold for {} {}: Node {}, here {got}", call["env"], call["args"], call["holdEnd"]));
            }
            // A promotion by the hold's own timer comes at the hold on Node's clock (the foreground timeout of the limit's timer
            // is not compared, see the manifest).
            if matches!(got, "background" | "threshold") && call["holdEndAt"].as_u64() != Some(hold) {
                failures.push(format!("when the hold ends for {} {}: Node {}, here {hold}", call["env"], call["args"], call["holdEndAt"]));
            }
        }
        compared += 1;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(compared > 100);
}

#[test]
fn oversized_commands_are_moved_to_a_file_as_node_moves_them() {
    let doc = recorded(mixdog_testkit::fixture!("../../fixtures/tools-untested/exec-hoist-long.json"));
    let path = doc["pathGiven"].as_str().unwrap();
    let mut failures = Vec::new();
    for (kind, plan_of) in [("inline", plan_long_inline_script_file_transport as fn(&str, bool, bool) -> Option<super::hoist::Hoist>), ("script", plan_long_shell_script_file_transport)] {
        for call in doc[kind].as_array().unwrap() {
            let command = call["command"].as_str().unwrap();
            let got = plan_of(command, call["platform"] == "win32", call["shellType"] == "powershell");
            let label = format!("{kind} {} {} ({} bytes)", call["platform"], call["shellType"], command.len());
            match (&call["plan"], got) {
                (Value::Null, None) => {}
                (Value::Null, Some(h)) => failures.push(format!("{label}: Node moves nothing, here a {} file", h.extension)),
                (_, None) => failures.push(format!("{label}: Node moves the command to a file, here nothing")),
                (want, Some(h)) => {
                    let body = if want["body"] == "<COMMAND>" { command } else { want["body"].as_str().unwrap() };
                    if h.extension != want["extension"].as_str().unwrap() || h.body != body || h.replace(path) != want["replaced"].as_str().unwrap() {
                        failures.push(format!("{label}: Node {} {:?}, here {} {:?}", want["extension"], want["replaced"], h.extension, h.replace(path)));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_shell_child_gets_the_session_cwd_and_the_launcher_first_on_path_as_node_builds_it() {
    let doc = recorded(mixdog_testkit::fixture!("../../fixtures/tools-untested/exec-env.json"));
    let windows = doc["platform"] == "win32";
    let mut failures = Vec::new();
    for case in doc["cases"].as_array().unwrap() {
        let vars: Vec<(String, String)> = case["base"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
        let env = shell_env(&vars, &ShellEnv { cwd: case["cwd"].as_str().unwrap(), windows, scratch_dir: None, skill_launcher_dir: Some(Path::new("<LAUNCHER>")) });
        // The child's whole environment: the inherited variables, then the ones set, less the ones removed.
        let mut got: serde_json::Map<String, Value> = vars.iter().map(|(k, v)| (k.clone(), Value::from(v.as_str()))).collect();
        for (name, value) in &env.set {
            got.insert(name.clone(), Value::from(value.as_str()));
        }
        for name in &env.remove {
            got.remove(name);
        }
        if Value::Object(got.clone()) != case["env"] {
            failures.push(format!("{}:\n  Node {}\n  here {}", case["base"], case["env"], Value::Object(got)));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
