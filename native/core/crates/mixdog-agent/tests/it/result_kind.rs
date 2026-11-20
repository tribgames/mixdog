use mixdog_agent::result_kind::{ResultKind, classify_result_kind};

/// The edges the recording's texts do not pin: JavaScript's whitespace (U+FEFF trims, U+0085 does not) and the
/// non-ASCII letters that never fold onto ASCII ones.
#[test]
fn whitespace_and_case_follow_javascript_not_rust() {
    assert_eq!(classify_result_kind("\u{feff}Error: x", "agent"), ResultKind::Error);
    assert_eq!(classify_result_kind("\u{85}Error: x", "agent"), ResultKind::Normal);
    assert_eq!(classify_result_kind("\u{a0}\u{2003}Error:x", "agent"), ResultKind::Error);
    assert_eq!(classify_result_kind("Error: ENOENT\u{e9}", "read"), ResultKind::ZeroMatch);
    assert_eq!(classify_result_kind("Error: xENOENT", "read"), ResultKind::Error);
}

/// The two inputs that Node and a hand-written matcher disagreed on: the opening `[code` is case-insensitive, and `file not found` has only
/// its trailing word boundary.
#[test]
fn the_error_prefix_ignores_case_and_file_not_found_has_no_leading_boundary() {
    assert_eq!(classify_result_kind("Error [CODE 3]: rejected", "agent"), ResultKind::Error);
    assert_eq!(classify_result_kind("Error: myfile not found", "read"), ResultKind::ZeroMatch);
    assert_eq!(classify_result_kind("Error: file not foundation", "read"), ResultKind::Error);
}


