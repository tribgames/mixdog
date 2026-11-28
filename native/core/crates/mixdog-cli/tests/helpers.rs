//! The helper processes a core starts as its own program (`current_exe`): `mixdogd` serves them (`mixdog_cli::helpers`), each with
//! its own grammar.
#![allow(clippy::disallowed_methods, reason = "the test runs the binary and reads its pipes")]

use std::io::Read;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

/// `ext-worker` sends the extension host's READY frame on its stdout and ends when the pool closes its stdin; `effort-judge-host`
/// takes the judge host's own options, so a line missing one is refused by that grammar (exit 2, naming the option).
#[test]
fn mixdogd_serves_the_helpers_its_core_starts() {
    let mut worker = Command::new(mixdog_testkit::bin_exe!("mixdogd"))
        .arg("ext-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the worker starts");
    let ready = mixdog_exthost_worker::wire::ready();
    let mut stdout = worker.stdout.take().expect("stdout");
    let (sent, first) = mpsc::channel();
    let length = ready.len();
    std::thread::spawn(move || {
        let mut frame = vec![0; length];
        let _ = sent.send(stdout.read_exact(&mut frame).map(|()| frame));
    });
    let frame = first.recv_timeout(Duration::from_secs(120)).expect("the worker's first frame").expect("the frame is read");
    assert_eq!(frame, ready.to_vec(), "the worker's first frame is READY");
    drop(worker.stdin.take());
    assert!(worker.wait().expect("the worker's exit").success(), "the worker ends when its pipe closes");

    let dir = tempfile::tempdir().unwrap();
    let judge = Command::new(mixdog_testkit::bin_exe!("mixdogd"))
        .args(["effort-judge-host", "--dir"])
        .arg(dir.path())
        .stdin(Stdio::null())
        .output()
        .expect("the judge host runs");
    let stderr = String::from_utf8_lossy(&judge.stderr);
    assert_eq!(judge.status.code(), Some(2), "{stderr}");
    assert!(stderr.contains("--ort-library"), "{stderr}");
}
