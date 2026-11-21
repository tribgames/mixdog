//! The interactive scenarios need `mixdogd` (`MIXDOGD_BIN`, or the one beside the test's target folder) built with mixdog-ai's
//! `test-support` feature, so its provider requests reach the stand-in (`REPLAY_PROVIDER_PIN`); they run with `-- --ignored`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the test runs the binary as a process and lays out folders")]

#[path = "support/procs.rs"]
mod procs;
#[path = "support/pty.rs"]
mod pty;
#[path = "support/sandbox.rs"]
mod sandbox;
#[path = "support/stand_in.rs"]
mod stand_in;

use std::ffi::OsString;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use sandbox::Sandbox;
use stand_in::StandIn;

const ANSWER: &str = "The stand-in answers.";
/// The time of all the waits of one scenario together: under nextest's limit (30 s × 4), so a wait that fails reports its screen
/// before the run kills the test.
const BUDGET: Duration = Duration::from_secs(100);

/// The waits of one scenario, sharing [`BUDGET`]; each failure names its step and shows the screen.
struct Steps<'a> {
    pty: &'a mut pty::Pty,
    end: Instant,
    stand_in: &'a StandIn,
}

impl Steps<'_> {
    fn left(&self) -> Duration {
        self.end.saturating_duration_since(Instant::now())
    }
    fn fail(&self, step: &str) -> ! {
        panic!("{step} (stand-in requests: {}); the screen:\n{}", self.stand_in.requests(), self.pty.screen().join("\n"))
    }
    fn stable(&self, step: &str) {
        if !self.pty.wait_stable(Duration::from_millis(700), self.left()) {
            self.fail(step);
        }
    }
    fn shows(&self, marker: &str, step: &str) {
        if !self.pty.wait_for(marker, self.left()) {
            self.fail(step);
        }
    }
    fn exits(&mut self) -> Option<u32> {
        let left = self.left();
        self.pty.wait_exit(left)
    }
}

/// Starts `mixdog args` in a pseudo-terminal.
fn interactive(sandbox: &Sandbox, stand_in: &StandIn, args: &[&str]) -> pty::Pty {
    let mut env = sandbox.env();
    env.extend(stand_in.pin().into_iter().map(|(name, value)| (OsString::from(name), OsString::from(value))));
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    pty::Pty::spawn(&OsString::from(mixdog_testkit::bin_exe!("mixdog")), &args, &sandbox.work(), &env)
}

#[test]
#[ignore = "needs mixdogd built with the test-support feature of mixdog-ai (MIXDOGD_BIN)"]
fn the_terminal_interface_boots_answers_and_exits_without_node() {
    let sandbox = Sandbox::new();
    let stand_in = StandIn::start(sandbox.root(), &[ANSWER]);
    let mut tui = interactive(&sandbox, &stand_in, &["--provider", "anthropic", "--model", "claude-sonnet-4-6"]);
    let watch = procs::Watch::start(tui.pid().unwrap());
    let mut steps = Steps { pty: &mut tui, end: Instant::now() + BUDGET, stand_in: &stand_in };
    steps.stable("the interface never booted");
    steps.pty.send(b"hello\r");
    steps.shows(ANSWER, "no answer on the screen");
    steps.pty.send(b"/exit\r");
    let code = steps.exits();
    let started = watch.finish();
    assert_eq!(code, Some(0), "/exit did not end the interface (stand-in requests: {}); the screen:\n{}", stand_in.requests(), tui.screen().join("\n"));
    assert!(started.is_empty(), "started {started:?}");
    assert!(stand_in.requests() >= 1);
}

#[test]
#[ignore = "needs mixdogd built with the test-support feature of mixdog-ai (MIXDOGD_BIN)"]
fn plain_answers_one_turn_without_node() {
    let sandbox = Sandbox::new();
    let stand_in = StandIn::start(sandbox.root(), &[ANSWER]);
    let mut repl = interactive(&sandbox, &stand_in, &["--plain", "--provider", "anthropic", "--model", "claude-sonnet-4-6"]);
    let watch = procs::Watch::start(repl.pid().unwrap());
    let mut steps = Steps { pty: &mut repl, end: Instant::now() + BUDGET, stand_in: &stand_in };
    steps.stable("the REPL never showed its prompt");
    steps.pty.send(b"hello\r");
    steps.shows(ANSWER, "no answer on the screen");
    steps.pty.send(b"/quit\r");
    let code = steps.exits();
    let started = watch.finish();
    assert_eq!(code, Some(0), "/quit did not end the REPL (stand-in requests: {}); the screen:\n{}", stand_in.requests(), repl.screen().join("\n"));
    assert!(started.is_empty(), "started {started:?}");
}

/// Runs `mixdog args` to its end with the sandbox's environment and the stand-in's pin; (exit code, stdout, stderr, the Node or
/// Electron images the watcher saw).
fn run(sandbox: &Sandbox, stand_in: &StandIn, args: &[&str]) -> (Option<i32>, String, String, Vec<String>) {
    let mut command = Command::new(install().unwrap_or_else(|| mixdog_testkit::bin_exe!("mixdog").into()));
    command.args(args).current_dir(sandbox.work()).env_clear().envs(sandbox.env()).envs(stand_in.pin());
    let child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let watch = procs::Watch::start(child.id());
    let output = child.wait_with_output().unwrap();
    (output.status.code(), String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&output.stderr).into_owned(), watch.finish())
}
fn install() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let node = std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|path| path.is_file())?;
    let dir = mixdog_testkit::target_tmpdir!().join(format!("node-free-install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("mixdog.exe");
    std::fs::hard_link(mixdog_testkit::bin_exe!("mixdog"), &exe).unwrap();
    let package = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").canonicalize().unwrap();
    std::fs::write(dir.join("js-runtime.json"), serde_json::json!({ "program": node, "packageRoot": package }).to_string()).unwrap();
    Some(exe)
}
#[test]
fn the_search_path_of_these_runs_names_neither_node_nor_electron() {
    for dir in std::env::split_paths(&sandbox::path_without_node()) {
        for program in ["node", "node.exe", "nodejs", "electron", "electron.exe"] {
            assert!(!dir.join(program).exists(), "{} holds {program}", dir.display());
        }
    }
}
#[test]
fn help_succeeds_without_node() {
    let sandbox = Sandbox::new();
    let stand_in = StandIn::start(sandbox.root(), &[ANSWER]);
    let (code, out, err, started) = run(&sandbox, &stand_in, &["--help"]);
    assert_eq!((code, err.as_str()), (Some(0), ""), "{out}");
    assert!(out.starts_with("mixdog"), "{out}");
    assert!(started.is_empty(), "started {started:?}");
}
#[test]
fn exec_succeeds_without_node_and_starts_neither_node_nor_electron() {
    if install().is_none() {
        return;
    }
    let sandbox = Sandbox::new();
    let stand_in = StandIn::start(sandbox.root(), &[ANSWER]);
    let (code, out, err, started) = run(&sandbox, &stand_in, &["exec", "--provider", "anthropic", "--model", "claude-sonnet-4-6", "go"]);
    assert_eq!(code, Some(0), "stdout: {out}\nstderr: {err}");
    assert!(out.contains(ANSWER), "{out}");
    assert!(stand_in.requests() >= 1);
    assert!(started.is_empty(), "started {started:?}");
}

#[test]
fn exec_json_streams_one_json_event_per_line_from_the_thread_start_to_the_successful_result() {
    if install().is_none() {
        return;
    }
    let sandbox = Sandbox::new();
    let stand_in = StandIn::start(sandbox.root(), &[ANSWER]);
    let (code, out, err, _) = run(&sandbox, &stand_in, &["exec", "--provider", "anthropic", "--model", "claude-sonnet-4-6", "--json", "go"]);
    assert_eq!(code, Some(0), "stdout: {out}\nstderr: {err}");
    let events: Vec<serde_json::Value> = out.lines().map(|line| serde_json::from_str(line).unwrap_or_else(|error| panic!("{line}: {error}"))).collect();
    assert!(events.iter().all(|event| event["schema_version"] == 1), "{out}");
    let types: Vec<&str> = events.iter().map(|event| event["type"].as_str().unwrap()).collect();
    assert_eq!(types[..2], ["thread.started", "turn.started"], "{types:?}");
    assert_eq!(types[types.len() - 2..], ["turn.completed", "result"], "{types:?}");
    assert!(
        events.iter().any(|event| event["type"] == "item.completed" && event["item"]["type"] == "agent_message" && event["item"]["text"] == ANSWER),
        "{out}"
    );
    let result = &events[events.len() - 1];
    assert_eq!(
        (result["subtype"].as_str(), result["is_error"].as_bool(), result["result"].as_str(), result["model"].as_str()),
        (Some("success"), Some(false), Some(ANSWER), Some("claude-sonnet-4-6"))
    );
    assert_eq!(events[0]["session"]["provider"], "anthropic", "{}", events[0]);
}

#[test]
fn exec_ends_with_the_providers_refusal_on_stderr_and_exit_code_1() {
    if install().is_none() {
        return;
    }
    let sandbox = Sandbox::new();
    let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"the request was refused"}}"#;
    let stand_in = StandIn::start_with(sandbox.root(), stand_in::Reply::Refuse(body.to_owned()));
    let (code, out, err, _) = run(&sandbox, &stand_in, &["exec", "--provider", "anthropic", "--model", "claude-sonnet-4-6", "go"]);
    assert_eq!(code, Some(1), "stdout: {out}\nstderr: {err}");
    assert_eq!(out, "", "an answer that never came prints nothing on stdout");
    assert!(err.lines().any(|line| line == format!("mixdog: 400 {body}")), "stderr: {err}");
}

#[test]
fn exec_ends_with_the_streams_error_on_stderr_and_exit_code_1_when_the_turn_breaks_midway() {
    if install().is_none() {
        return;
    }
    let sandbox = Sandbox::new();
    let stand_in = StandIn::start_with(sandbox.root(), stand_in::Reply::BreakStream("the turn broke".to_owned()));
    let (code, out, err, _) = run(&sandbox, &stand_in, &["exec", "--provider", "anthropic", "--model", "claude-sonnet-4-6", "go"]);
    assert_eq!(code, Some(1), "stdout: {out}\nstderr: {err}");
    assert!(err.lines().any(|line| line == "mixdog: Anthropic SSE error invalid_request_error: the turn broke"), "stderr: {err}");
}
