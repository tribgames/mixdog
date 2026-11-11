use super::*;

// The recorder's ends (panic, fatal boot error, exit code, kill, abort) are replayed through the real binary's start-up:
// mixdog-cli/tests/crash_record_replay.rs.
#[test]
fn an_exit_is_described_as_node_describes_it() {
    assert_eq!(describe_exit(Some(0)), "exited normally (code 0)");
    assert_eq!(describe_exit(Some(7)), "exited with code 7");
    assert_eq!(describe_exit(Some(0xC000_013Au32 as i32)), "terminated by Ctrl+C / console close (STATUS_CONTROL_C_EXIT 0xC000013A)");
    assert_eq!(describe_exit(None), "exit not observed");
    assert!(is_capture_record("daemon-20260915-064900-123-0a9f.json"));
    assert!(!is_capture_record("daemon-20260915-064900-123-0a9f.err.log"));
    assert!(!is_capture_record("daemon-2026091-064900-123-0a9f.json"));
}
