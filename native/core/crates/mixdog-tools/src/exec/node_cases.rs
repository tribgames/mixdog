//! What Node answers for the exec helpers its own tests assert (`fixtures/tools-untested/exec-*.json`,
//! `record-tools-untested.mjs`), replayed whole and in the recorded order.

use super::benign::is_benign_search_exit_one;
use super::env::{ShellEnv, shell_env};
use super::hoist::{plan_long_inline_script_file_transport, plan_long_shell_script_file_transport};
use super::shell::{Args, foreground_cap_ms, hold_ms, time_limit_ms};
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
        let explicit = call["args"]["timeout_ms"].as_u64().is_some_and(|t| t > 0);
        let plan = &call["plan"];
        let promote = enabled && (!explicit || limit > foreground_cap_ms(hold, &env));
        let got = [("autoBackgroundMs", hold, plan["autoBackgroundMs"].as_u64().unwrap()), ("backgroundDeadlineMs", limit, plan["backgroundDeadlineMs"].as_u64().unwrap())];
        for (what, here, node) in got {
            if here != node {
                failures.push(format!("{what} for {} {} (background {enabled}): Node {node}, here {here}", call["env"], call["args"]));
            }
        }
        if promote != plan["promoteAtTimeout"].as_bool().unwrap() {
            failures.push(format!("promoteAtTimeout for {} {} (background {enabled}): Node {}, here {promote}", call["env"], call["args"], plan["promoteAtTimeout"]));
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
        let get = |name: &str| env.set.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
        if get("PATH") != case["PATH"].as_str() || get("MIXDOG_SESSION_CWD") != case["MIXDOG_SESSION_CWD"].as_str() {
            failures.push(format!("{}: Node PATH {} cwd {}, here PATH {:?} cwd {:?}", case["base"], case["PATH"], case["MIXDOG_SESSION_CWD"], get("PATH"), get("MIXDOG_SESSION_CWD")));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
