//! The words of an unreachable server's failed host-key read.

use super::scan_failure_lines;

#[test]
fn a_server_that_is_down_is_reported_once_not_once_per_key_type() {
    let scan = "# example.test:22 SSH-2.0-banner\n\
        connect (`example.test'): Connection refused\n\
        # example.test:22 SSH-2.0-banner\n\
        connect (`example.test'): Connection refused\n\
        connect (`example.test'): Connection refused\n";
    assert_eq!(scan_failure_lines(scan), "connect (`example.test'): Connection refused");
    assert_eq!(scan_failure_lines("first\nsecond\nfirst"), "first\nsecond", "different lines all stay, in order");
    assert_eq!(scan_failure_lines(""), "");
}
