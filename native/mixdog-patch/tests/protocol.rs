use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn run_server(input: &str) -> String {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-patch"))
        .arg("--server")
        .env("MIXDOG_PATCH_SERVER_IDLE_MS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start patch server");
    child.stdin.take().unwrap().write_all(input.as_bytes()).expect("send requests");
    let output = child.wait_with_output().expect("server exits after QUIT");
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    String::from_utf8(output.stdout).unwrap()
}

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("mixdog-patch-cli-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run_cli(args: &[&str], stdin: &[u8]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-patch"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start patch cli");
    child.stdin.take().unwrap().write_all(stdin).expect("send stdin");
    child.wait_with_output().expect("cli exits")
}

#[test]
fn server_answers_ping_with_pong_for_lf_and_crlf_headers() {
    assert_eq!(run_server("PING\r\nPING\nQUIT\n"), "OK\tPONG\nOK\tPONG\n");
}

#[test]
fn server_reports_the_engine_contract_it_implements() {
    assert_eq!(run_server("CONTRACT\nQUIT\n"), "OK\tmixdog-patch-engine-contract:3\n");
}

#[test]
fn server_rejects_malformed_edit_headers_and_keeps_serving() {
    let input = concat!("EDIT\n", "EDIT x 0 0 0 0\n", "EDIT 0 x 0 0 0\n", "EDIT 0 0 x 0 0\n", "EDIT 0 0 0 2 0\n", "EDIT\t0 0 0 0 1\r\n", "PING\n", "QUIT\n",);
    assert_eq!(
        run_server(input),
        concat!(
            "ERR\tbad edit header\n",
            "ERR\tbad path length\n",
            "ERR\tbad old length\n",
            "ERR\tbad new length\n",
            "ERR\tbad replace_all value\n",
            "ERR\told_string is empty\n",
            "OK\tPONG\n",
        )
    );
}

#[test]
fn server_rejects_malformed_apply_headers_and_keeps_serving() {
    let input = concat!(
        "APPLY\n",
        "APPLY x 0 0 0 0 0\n",
        "APPLY 0 x 0 0 0 0\n",
        "APPLY 0 0 0 0 x 0\n",
        "APPLY 0 0 0 0 0 2\n",
        "APPLY\t0 0 0 1 0 1\r\n",
        "PING\n",
        "QUIT\n",
    );
    assert_eq!(
        run_server(input),
        concat!(
            "ERR\tbad header\n",
            "ERR\tbad base length\n",
            "ERR\tbad patch length\n",
            "ERR\tbad fuzz value\n",
            "ERR\tbad reject_partial value\n",
            "ERR\tpatch contained no file sections\n",
            "OK\tPONG\n",
        )
    );
}

#[test]
fn cli_applies_a_patch_from_stdin_under_the_base_directory() {
    let dir = temp_dir("apply");
    std::fs::write(dir.join("a.txt"), b"one\n").unwrap();
    let output = run_cli(&["--base", dir.to_str().unwrap()], b"--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-one\n+ONE\n");
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "applied 1\n");
    assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"ONE\n");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn cli_edit_reads_old_then_new_bytes_from_stdin() {
    let dir = temp_dir("edit");
    let path = dir.join("f.txt");
    std::fs::write(&path, b"alpha\nbeta\n").unwrap();
    let output = run_cli(&["--edit", "--path", path.to_str().unwrap(), "--old-len", "4", "--new-len", "4"], b"betaBETA");
    assert!(output.status.success());
    let line = String::from_utf8(output.stdout).unwrap();
    let fields: Vec<&str> = line.trim_end().split('\t').collect();
    assert_eq!(fields[0], "OK");
    assert_eq!(fields[1], "1");
    assert_eq!(fields[6], "exact");
    assert_eq!(std::fs::read(&path).unwrap(), b"alpha\nBETA\n");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn cli_rejects_an_unknown_argument_with_a_nonzero_exit() {
    let output = run_cli(&["--bogus"], b"");
    assert!(!output.status.success());
    assert_eq!(String::from_utf8(output.stderr).unwrap(), "mixdog-patch: unknown argument: --bogus\n");
}
