//! The host process's protocol, byte for byte, through the test host binary (`tests/bin/office_com_host_test.rs`: the same
//! `host::run_with` as `mixdogd office-com-host`, with scripted operations and a handle log in place of Office's): what is
//! written on stdout and stderr, the exit code, and that every handle was released and the apartment left last.
//!
//! The expected lines are those of the PowerShell hosts' `Emit-Json`, error line and `finally` blocks
//! (`assets/office-com-host.ps1`, `assets/office-com-session-host.ps1`). Transcripts recorded from the PowerShell hosts
//! against Office need a PC with Office (`recorder/`); the lines here were read from the scripts, not recorded.

use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const HOST: &str = env!("CARGO_BIN_EXE_office-com-host-test");

struct Run {
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

impl Run {
    /// stdout without its last line end, split at CRLF; every line must end with CRLF.
    fn lines(&self) -> Vec<&str> {
        assert!(self.stdout.is_empty() || self.stdout.ends_with("\r\n"), "every line ends with CRLF: {:?}", self.stdout);
        assert!(!self.stdout.starts_with('\u{feff}'), "no byte order mark");
        let body = self.stdout.strip_suffix("\r\n").unwrap_or(&self.stdout);
        if self.stdout.is_empty() { Vec::new() } else { body.split("\r\n").collect() }
    }

    fn json(&self, index: usize) -> Value {
        serde_json::from_str(self.lines()[index]).expect("a JSON line")
    }

    /// The test host's event log (stderr lines `EVENT <text>`).
    fn events(&self) -> Vec<&str> {
        self.stderr.lines().filter_map(|line| line.strip_prefix("EVENT ")).collect()
    }

    /// The cleanup lines (`MIXDOG_OFFICE_CLEANUP <text>`), CRLF included.
    fn cleanup_lines(&self) -> Vec<&str> {
        self.stderr.split_inclusive("\r\n").filter(|line| line.starts_with("MIXDOG_OFFICE_CLEANUP ")).collect()
    }

    /// Every handle that was acquired was released, and `CoUninitialize` is the last thing the host did.
    fn assert_exit_discipline(&self, handles: usize) {
        let events = self.events();
        for id in 1..=handles {
            assert!(events.contains(&format!("Acquire h{id}").as_str()), "h{id} acquired: {events:?}");
            assert!(events.contains(&format!("Release h{id}").as_str()), "h{id} released: {events:?}");
        }
        assert_eq!(events.first().copied(), Some("CoInitialize"), "{events:?}");
        assert_eq!(events.last().copied(), Some("CoUninitialize"), "{events:?}");
        assert_eq!(events.iter().filter(|event| **event == "CoUninitialize").count(), 1, "{events:?}");
        let last_release = events.iter().rposition(|event| event.starts_with("Release"));
        if let Some(at) = last_release {
            assert!(at < events.len() - 1, "nothing is released after the apartment was left: {events:?}");
        }
    }
}

async fn host(args: &[&str], stdin: &str) -> Run {
    let mut child = Command::new(HOST)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the test host starts");
    let mut input = child.stdin.take().expect("stdin");
    // The host may end before it reads everything (after `close_session`): a broken pipe is not a failure.
    let _ = input.write_all(stdin.as_bytes()).await;
    drop(input);
    let output = mixdog_rt::time::timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .expect("the host ended")
        .expect("the host's output");
    Run {
        stdout: String::from_utf8(output.stdout).expect("utf-8 stdout"),
        stderr: String::from_utf8(output.stderr).expect("utf-8 stderr"),
        code: output.status.code(),
    }
}

fn lines(requests: &[&str]) -> String {
    requests.iter().map(|request| format!("{request}\n")).collect()
}

const ERROR_PREFIX: &str = "{\"ok\":false,\"backend\":\"microsoft-office-com\",\"error\":";

#[tokio::test]
async fn an_empty_one_shot_request_is_refused_and_exits_one() {
    for stdin in ["", " \r\n\t\r\n"] {
        let run = host(&["office-com-host"], stdin).await;
        assert_eq!(run.stdout, format!("{ERROR_PREFIX}\"Office host received an empty request\"}}\r\n"));
        assert_eq!(run.code, Some(1));
        assert!(run.events().contains(&"Finish"), "the handler's finally ran");
        run.assert_exit_discipline(0);
    }
}

#[tokio::test]
async fn a_one_shot_call_writes_exactly_one_line_and_exits_zero() {
    let run = host(&["office-com-host"], "{\"action\":\"snapshot\",\"format\":\"docx\",\"scenario\":{\"hold\":2}}").await;
    assert_eq!(run.stdout, "{\"ok\":true,\"backend\":\"microsoft-office-com\",\"action\":\"snapshot\"}\r\n");
    assert_eq!(run.code, Some(0));
    assert_eq!(run.cleanup_lines(), Vec::<&str>::new());
    run.assert_exit_discipline(2);
}

#[tokio::test]
async fn a_one_shot_request_with_multibyte_text_is_read_whole() {
    let run = host(&["office-com-host"], "{\"action\":\"caf\u{e9} \u{1f600}\"}").await;
    assert_eq!(run.json(0)["action"], "caf\u{e9} \u{1f600}");
    assert_eq!(run.lines().len(), 1);
}

#[tokio::test]
async fn a_failed_one_shot_call_is_an_error_line_exit_one_and_every_handle_released() {
    let run = host(&["office-com-host"], "{\"action\":\"x\",\"scenario\":{\"hold\":3,\"fail\":\"Range failed\"}}").await;
    assert_eq!(run.stdout, format!("{ERROR_PREFIX}\"Range failed\"}}\r\n"));
    assert_eq!(run.code, Some(1));
    run.assert_exit_discipline(3);
}

#[tokio::test]
async fn a_panic_in_a_one_shot_call_is_answered_as_an_error_and_the_cleanup_still_runs() {
    let run = host(&["office-com-host"], "{\"action\":\"x\",\"scenario\":{\"hold\":2,\"panic\":\"a bug\"}}").await;
    assert_eq!(run.stdout, format!("{ERROR_PREFIX}\"a bug\"}}\r\n"));
    assert_eq!(run.code, Some(1));
    assert!(run.events().contains(&"Finish"));
    run.assert_exit_discipline(2);
}

#[tokio::test]
async fn a_one_shot_cleanup_that_failed_is_written_on_stderr_and_does_not_change_the_exit_code() {
    let run = host(&["office-com-host"], "{\"action\":\"x\",\"scenario\":{\"cleanupFail\":true}}").await;
    assert_eq!(run.code, Some(0));
    assert_eq!(run.lines().len(), 1);
    assert_eq!(
        run.cleanup_lines(),
        ["MIXDOG_OFFICE_CLEANUP {\"ok\":false,\"errors\":[\"Document close failed: scripted\"]}\r\n"]
    );
}

#[tokio::test]
async fn a_one_shot_that_is_not_json_is_an_error_line() {
    let run = host(&["office-com-host"], "{\"action\":").await;
    assert!(run.stdout.starts_with(ERROR_PREFIX), "{:?}", run.stdout);
    assert_eq!(run.lines().len(), 1);
    assert_eq!(run.code, Some(1));
}

const OPEN: &str = "{\"action\":\"open_session\",\"session\":\"s1\",\"requestId\":\"r1\",\"scenario\":{\"hold\":2,\"identity\":true}}";

#[tokio::test]
async fn a_session_echoes_the_request_id_and_writes_the_identity_line_before_the_open_answer() {
    let run = host(
        &["office-com-host", "--session"],
        &lines(&[
            OPEN,
            "",
            "   ",
            "{\"action\":\"snapshot\",\"session\":\"s1\",\"requestId\":\"r2\"}",
            "{\"action\":\"close_session\",\"session\":\"s1\",\"requestId\":\"r3\"}",
        ]),
    )
    .await;
    let out = run.lines();
    assert_eq!(out.len(), 4, "identity, open, snapshot, close: {out:?}");
    assert_eq!(out[0], "{\"session\":\"s1\",\"ok\":true,\"ownership\":\"owned\",\"appPid\":4242,\"lifecycle\":\"initializing\"}");
    assert!(run.json(0).get("requestId").is_none(), "the identity line has no requestId");
    assert_eq!(out[1], "{\"ok\":true,\"backend\":\"microsoft-office-com\",\"opened\":true,\"session\":\"s1\",\"appPid\":4242,\"requestId\":\"r1\"}");
    assert_eq!(out[2], "{\"ok\":true,\"backend\":\"microsoft-office-com\",\"action\":\"snapshot\",\"requestId\":\"r2\"}");
    assert_eq!(out[3], "{\"ok\":true,\"closed\":true,\"cleanup\":{\"ok\":true,\"errors\":[]},\"requestId\":\"r3\"}");
    assert_eq!(run.code, Some(0));
}

#[tokio::test]
async fn a_session_that_answered_close_ends_without_a_second_cleanup() {
    let run = host(
        &["office-com-host", "--session"],
        &lines(&[
            OPEN,
            "{\"action\":\"close_session\",\"session\":\"s1\",\"requestId\":\"r2\"}",
            "{\"action\":\"snapshot\",\"session\":\"s1\",\"requestId\":\"r3\"}",
        ]),
    )
    .await;
    assert_eq!(run.lines().len(), 3, "identity, open, close: nothing is answered after the close");
    assert!(!run.events().contains(&"EndCleanup"), "{:?}", run.events());
    assert_eq!(run.cleanup_lines(), Vec::<&str>::new());
    assert_eq!(run.code, Some(0));
}

#[tokio::test]
async fn the_three_refusals_of_the_session_loop() {
    let run = host(
        &["office-com-host", "--session"],
        &lines(&[
            "{\"action\":\"snapshot\",\"session\":\"s1\",\"requestId\":\"a\"}",
            OPEN,
            "{\"action\":\"open_session\",\"session\":\"s2\",\"requestId\":\"b\"}",
            "{\"action\":\"snapshot\",\"session\":\"other\",\"requestId\":\"c\"}",
        ]),
    )
    .await;
    let out = run.lines();
    assert_eq!(out[0], format!("{ERROR_PREFIX}\"Office session host has no open document\",\"requestId\":\"a\"}}"));
    assert_eq!(
        out[3],
        format!("{ERROR_PREFIX}\"Office session is already open in this host\",\"session\":\"s1\",\"appPid\":4242,\"requestId\":\"b\"}}")
    );
    assert_eq!(
        out[4],
        format!("{ERROR_PREFIX}\"Office session id does not match this host\",\"session\":\"s1\",\"appPid\":4242,\"requestId\":\"c\"}}")
    );
    assert_eq!(run.code, Some(0));
    assert_eq!(run.events().iter().filter(|event| **event == "EndCleanup").count(), 1, "the open session was cleaned up at EOF");
}

#[tokio::test]
async fn end_of_input_cleans_up_the_open_session_and_reports_a_failed_cleanup_on_stderr() {
    let open = "{\"action\":\"open_session\",\"session\":\"s1\",\"requestId\":\"r1\",\"scenario\":{\"hold\":2,\"cleanupFail\":true}}";
    let run = host(&["office-com-host", "--session"], &lines(&[open])).await;
    assert_eq!(run.code, Some(0));
    assert_eq!(
        run.cleanup_lines(),
        ["MIXDOG_OFFICE_CLEANUP {\"ok\":false,\"errors\":[\"Document close failed: scripted\"]}\r\n"]
    );
    let events = run.events();
    let cleanup = events.iter().position(|event| *event == "EndCleanup").expect("the cleanup ran");
    let release = events.iter().position(|event| event.starts_with("Release")).expect("handles released");
    assert!(cleanup < release, "the handles are released by the cleanup: {events:?}");
    run.assert_exit_discipline(2);
}

#[tokio::test]
async fn a_session_cleanup_that_succeeded_writes_nothing() {
    let run = host(&["office-com-host", "--session"], &lines(&[OPEN])).await;
    assert_eq!(run.cleanup_lines(), Vec::<&str>::new());
    run.assert_exit_discipline(2);
}

#[tokio::test]
async fn a_panic_in_a_session_request_is_an_error_answer_and_the_state_is_cleaned_up_at_the_end() {
    let run = host(
        &["office-com-host", "--session"],
        &lines(&[OPEN, "{\"action\":\"snapshot\",\"session\":\"s1\",\"requestId\":\"p\",\"scenario\":{\"panic\":\"a bug\"}}"]),
    )
    .await;
    let out = run.lines();
    assert_eq!(out.len(), 3);
    assert_eq!(out[2], format!("{ERROR_PREFIX}\"a bug\",\"session\":\"s1\",\"appPid\":4242,\"requestId\":\"p\"}}"));
    assert_eq!(run.code, Some(0));
    assert!(run.events().contains(&"EndCleanup"));
    run.assert_exit_discipline(2);
}

#[tokio::test]
async fn a_failed_close_keeps_the_session_and_the_cleanup_runs_at_the_end() {
    let run = host(
        &["office-com-host", "--session"],
        &lines(&[
            OPEN,
            "{\"action\":\"close_session\",\"session\":\"s1\",\"requestId\":\"c\",\"scenario\":{\"closeFails\":true}}",
            "{\"action\":\"snapshot\",\"session\":\"s1\",\"requestId\":\"e\"}",
        ]),
    )
    .await;
    let out = run.lines();
    assert_eq!(out.len(), 4, "the loop went on after the failed close");
    assert_eq!(run.json(2)["closed"], false);
    assert_eq!(run.json(3)["ok"], true);
    assert!(run.events().contains(&"EndCleanup"));
    run.assert_exit_discipline(2);
}

/// Windows with Microsoft Office: the host thread is an STA, and a Word session opened through a test handler and sent
/// the end of its input while busy closes its document and lets WINWORD exit.
#[cfg(windows)]
mod live {
    use super::*;

    fn live_enabled() -> bool {
        std::env::var("MIXDOG_TEST_LIVE_OFFICE").is_ok_and(|value| value == "1")
    }

    async fn word_processes() -> usize {
        let output = Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq WINWORD.EXE", "/NH"])
            .output()
            .await
            .expect("tasklist runs");
        String::from_utf8_lossy(&output.stdout).lines().filter(|line| line.contains("WINWORD.EXE")).count()
    }

    #[tokio::test]
    #[ignore = "starts Word; MIXDOG_TEST_LIVE_OFFICE=1"]
    async fn host_live_sta() {
        if !live_enabled() {
            return;
        }
        let before = word_processes().await;
        let run = host(
            &["office-com-host", "--session", "--live"],
            &lines(&[
                "{\"action\":\"open_session\",\"session\":\"live\",\"requestId\":\"o\"}",
                "{\"action\":\"snapshot\",\"session\":\"live\",\"requestId\":\"b\",\"scenario\":{\"busy\":true}}",
            ]),
        )
        .await;
        assert_eq!(run.code, Some(0), "{}", run.stderr);
        let apartment = run.json(0)["apartmentType"].as_i64().expect("an apartment type");
        assert!(apartment == 0 || apartment == 3, "STA or the main STA, got {apartment}");
        assert_eq!(run.json(1)["ok"], true);
        assert_eq!(run.cleanup_lines(), Vec::<&str>::new(), "the document closed and the application quit");
        let mut waited = 0;
        while word_processes().await > before && waited < 40 {
            mixdog_rt::time::sleep(Duration::from_millis(500)).await;
            waited += 1;
        }
        assert!(word_processes().await <= before, "WINWORD exited");
    }
}
