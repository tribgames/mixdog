//! The Node terminal interface (`node C:/Project/mixdog/src/cli.mjs`) and the Rust `mixdog` run in identical pseudo-terminals
//! ([`pty::COLUMNS`] x [`pty::ROWS`]), each in its own throwaway home against the same stand-in provider, are sent the same
//! scripted keystrokes, and their screens are compared row by row at stable checkpoints: after boot, after a streamed answer, with
//! a picker open, after a scroll and after `/exit`.
//!
//! Only what differs by nature is tolerated, and only as the masks of [`mask`]: a session id (hex or UUID), a clock time, a
//! version number, the sandbox's path and a duration. Everything else, every cell of every row, must be equal.
//!
//! Ignored by default: it needs `node` on the PATH, the Node tree at `C:/Project/mixdog` (override: `MIXDOG_NODE_TREE`) and a
//! `mixdogd` built with the `test-support` feature of mixdog-ai for the Rust side (`MIXDOGD_BIN`). It starts real programs and
//! terminals; run it with `cargo test --offline -p mixdog-entry --test pty_twin -- --ignored`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the test runs two programs and lays out folders")]

#[path = "../../mixdog-cli/tests/support/request.rs"]
mod request;
#[path = "support/pty.rs"]
mod pty;
#[path = "support/sandbox.rs"]
mod sandbox;
#[path = "support/stand_in.rs"]
mod stand_in;

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use sandbox::Sandbox;
use stand_in::StandIn;

const ANSWER: &str = "The stand-in answers.";
const QUIET: Duration = Duration::from_millis(900);
const DEADLINE: Duration = Duration::from_secs(120);

/// The checkpoints, in order, with the keystrokes that lead to each from the one before.
const SCRIPT: [(&str, &str); 5] = [
    ("after boot", ""),
    ("after a streamed answer", "hello\r"),
    ("picker open", "/model\r"),
    // Escape closes the picker; PageUp scrolls the transcript.
    ("after scroll", "\x1b\x1b[5~"),
    ("after /exit", "/exit\r"),
];

/// Replaces what may differ between the two programs with a fixed word.
fn mask(row: &str, sandbox: &str) -> String {
    let mut text = row.replace(sandbox, "<sandbox>").replace(&sandbox.replace('\\', "/"), "<sandbox>");
    let patterns: [(&str, &str); 5] = [
        (r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", "<id>"),
        (r"\b[0-9a-f]{8,32}\b", "<id>"),
        (r"\b\d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?\b", "<time>"),
        (r"\bv?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\b", "<version>"),
        (r"\b\d+(\.\d+)?(ms|s)\b", "<duration>"),
    ];
    for (pattern, word) in patterns {
        text = regex::Regex::new(pattern).unwrap().replace_all(&text, word).into_owned();
    }
    text
}

/// Where the Node tree is.
fn node_tree() -> PathBuf {
    PathBuf::from(std::env::var("MIXDOG_NODE_TREE").unwrap_or_else(|_| "C:/Project/mixdog".to_owned()))
}

/// One program's screens at the checkpoints.
fn play(program: OsString, args: Vec<OsString>, extra: Vec<(OsString, OsString)>, sandbox: &Sandbox) -> Vec<(String, Vec<String>)> {
    let mut env = sandbox.env();
    env.extend(extra);
    let mut session = pty::Pty::spawn(&program, &args, &sandbox.work(), &env);
    let mut screens = Vec::new();
    for (name, keys) in SCRIPT {
        if !keys.is_empty() {
            session.send(keys.as_bytes());
        }
        if name == "after /exit" {
            let code = session.wait_exit(DEADLINE);
            assert_eq!(code, Some(0), "the program did not exit cleanly after /exit");
        } else {
            assert!(session.wait_stable(QUIET, DEADLINE), "{name}: the screen never settled");
            if name == "after a streamed answer" {
                assert!(session.wait_for(ANSWER, DEADLINE), "{name}: no answer\n{}", session.screen().join("\n"));
                assert!(session.wait_stable(QUIET, DEADLINE));
            }
        }
        screens.push((name.to_owned(), session.screen()));
    }
    screens
}

#[test]
#[ignore = "starts the Node interface and the Rust binary in pseudo-terminals (node, C:/Project/mixdog, MIXDOGD_BIN)"]
fn the_rust_terminal_interface_shows_what_the_node_one_shows_at_every_checkpoint() {
    let route = ["--provider", "anthropic", "--model", "claude-sonnet-4-6"].map(OsString::from);

    let node_box = Sandbox::new();
    let node_stand_in = StandIn::start(node_box.root(), &[ANSWER]);
    let tap = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/tap.mjs");
    let mut node_args: Vec<OsString> = vec!["--import".into(), url_of(&tap).into(), node_tree().join("src/cli.mjs").into_os_string()];
    node_args.extend(route.clone());
    // Node needs itself on the PATH: the sandbox's node-free PATH is replaced by the host's.
    let node_env = vec![("PATH".into(), std::env::var_os("PATH").unwrap_or_default()), ("BENCH_PROVIDER_PORT".into(), node_stand_in.http_port().to_string().into())];
    let node = play("node".into(), node_args, node_env, &node_box);

    let rust_box = Sandbox::new();
    let rust_stand_in = StandIn::start(rust_box.root(), &[ANSWER]);
    let rust_env: Vec<(OsString, OsString)> = rust_stand_in.pin().into_iter().map(|(name, value)| (OsString::from(name), OsString::from(value))).collect();
    let rust = play(OsString::from(env!("CARGO_BIN_EXE_mixdog")), route.to_vec(), rust_env, &rust_box);

    let (node_root, rust_root) = (node_box.root().to_string_lossy().into_owned(), rust_box.root().to_string_lossy().into_owned());
    let mut differences = Vec::new();
    for ((name, node_rows), (_, rust_rows)) in node.iter().zip(&rust) {
        for row in 0..node_rows.len().max(rust_rows.len()) {
            let node_row = mask(node_rows.get(row).map_or("", String::as_str), &node_root);
            let rust_row = mask(rust_rows.get(row).map_or("", String::as_str), &rust_root);
            if node_row != rust_row {
                differences.push(format!("{name}, row {row}:\n  node: {node_row}\n  rust: {rust_row}"));
            }
        }
    }
    assert!(differences.is_empty(), "{} rows differ:\n{}", differences.len(), differences.join("\n"));
}

/// A file as the `file:` URL `node --import` takes.
fn url_of(path: &std::path::Path) -> String {
    format!("file:///{}", path.to_string_lossy().replace('\\', "/"))
}

#[test]
fn the_masks_leave_text_that_differs_in_anything_but_ids_times_versions_and_the_sandbox() {
    assert_eq!(mask("session 3f2a9c1e-1111-4222-8333-444455556666 at 12:34:56 v1.2.3 in C:\\box\\work 120ms", "C:\\box"), "session <id> at <time> <version> in <sandbox>\\work <duration>");
    assert_ne!(mask("model: alpha", "/x"), mask("model: beta", "/x"));
}
