//! The shipped paths of the `mixdog` binary run on a machine without Node or Electron: the `PATH` of every run holds no folder with
//! either program (tests/support/sandbox.rs), and a watcher samples the process table every 25 ms for a Node or Electron image
//! below the run. Each scenario must succeed and the watcher must see none.
//!
//! `--help` and `exec` run anywhere the package builds. The two interactive scenarios (the terminal interface and `--plain`) run in a
//! pseudo-terminal against a core: they need `mixdogd` (`MIXDOGD_BIN`, or the one beside the test's target folder) built with the
//! `test-support` feature of mixdog-ai, so that its provider requests reach the stand-in (`REPLAY_PROVIDER_PIN`); they are ignored by
//! default and run with `-- --ignored`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the test runs the binary as a process and lays out folders")]

#[path = "../../mixdog-cli/tests/support/request.rs"]
mod request;
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

use sandbox::Sandbox;
use stand_in::StandIn;

const ANSWER: &str = "The stand-in answers.";
const DEADLINE: Duration = Duration::from_secs(120);

/// Runs `mixdog args` to its end with the sandbox's environment and the stand-in's pin; (exit code, stdout, stderr, the Node or
/// Electron images the watcher saw).
fn run(sandbox: &Sandbox, stand_in: &StandIn, args: &[&str]) -> (Option<i32>, String, String, Vec<String>) {
    let mut command = Command::new(install().unwrap_or_else(|| env!("CARGO_BIN_EXE_mixdog").into()));
    command.args(args).current_dir(sandbox.work()).env_clear().envs(sandbox.env()).envs(stand_in.pin());
    let child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let watch = procs::Watch::start(child.id());
    let output = child.wait_with_output().unwrap();
    (output.status.code(), String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&output.stderr).into_owned(), watch.finish())
}

/// An install of the binary under test, as a product install is: the binary hard-linked beside a `js-runtime.json` that names
/// this tree as the package and the interpreter the install carries (the host's Node, by its full path). The search path of
/// the runs holds no Node, and the watcher proves the run starts none: the interpreter is there for the scripts of users, and
/// nothing of `exec` or the terminal UI runs on it. `None` on a host with no Node to lay an install out with.
fn install() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let node = std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|path| path.is_file())?;
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("node-free-install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("mixdog.exe");
    std::fs::hard_link(env!("CARGO_BIN_EXE_mixdog"), &exe).unwrap();
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

/// Starts `mixdog args` in a pseudo-terminal.
fn interactive(sandbox: &Sandbox, stand_in: &StandIn, args: &[&str]) -> pty::Pty {
    let mut env = sandbox.env();
    env.extend(stand_in.pin().into_iter().map(|(name, value)| (OsString::from(name), OsString::from(value))));
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    pty::Pty::spawn(&OsString::from(env!("CARGO_BIN_EXE_mixdog")), &args, &sandbox.work(), &env)
}

#[test]
#[ignore = "needs mixdogd built with the test-support feature of mixdog-ai (MIXDOGD_BIN)"]
fn the_terminal_interface_boots_answers_and_exits_without_node() {
    let sandbox = Sandbox::new();
    let stand_in = StandIn::start(sandbox.root(), &[ANSWER]);
    let mut tui = interactive(&sandbox, &stand_in, &["--provider", "anthropic", "--model", "claude-sonnet-4-6"]);
    let watch = procs::Watch::start(tui.pid().unwrap());
    assert!(tui.wait_stable(Duration::from_millis(700), DEADLINE), "the interface never booted");
    tui.send(b"hello\r");
    assert!(tui.wait_for(ANSWER, DEADLINE), "no answer on the screen:\n{}", tui.screen().join("\n"));
    tui.send(b"/exit\r");
    let code = tui.wait_exit(DEADLINE);
    let started = watch.finish();
    assert_eq!(code, Some(0), "{}", tui.screen().join("\n"));
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
    assert!(repl.wait_stable(Duration::from_millis(700), DEADLINE), "the REPL never showed its prompt");
    repl.send(b"hello\r");
    assert!(repl.wait_for(ANSWER, DEADLINE), "no answer on the screen:\n{}", repl.screen().join("\n"));
    repl.send(b"/quit\r");
    let code = repl.wait_exit(DEADLINE);
    let started = watch.finish();
    assert_eq!(code, Some(0), "{}", repl.screen().join("\n"));
    assert!(started.is_empty(), "started {started:?}");
}
