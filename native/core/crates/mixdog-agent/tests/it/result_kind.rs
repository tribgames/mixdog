use mixdog_agent::result_kind::{ResultKind, classify_result_kind};

/// Every case of Node's `classifyResultKind` recording (`fixtures/result-classification/golden.json`,
/// `record-result-classification.mjs`): 13 tool names over 45 texts, plus a generated grid over every phrase of both navigation regexes (four letter cases, seven neighbours before and\n/// after) and over the error prefix (separators, openings, lead-ins), answered as Node answers them.
#[test]
fn the_returned_text_is_classified_as_nodes_classify_result_kind_classifies_it() {
    let golden: serde_json::Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/result-classification/golden.json")).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() > 9000, "the recording is whole");
    for case in cases {
        let Some(text) = case["text"].as_str() else {
            // A result that is not text is `normal`; the host's outputs are always text.
            assert_eq!(case["kind"], "normal");
            continue;
        };
        let want = match case["kind"].as_str().unwrap() {
            "error" => ResultKind::Error,
            "zero-match" => ResultKind::ZeroMatch,
            "normal" => ResultKind::Normal,
            other => panic!("kind {other}"),
        };
        assert_eq!(classify_result_kind(text, case["tool"].as_str().unwrap()), want, "tool {} text {text:?}", case["tool"]);
    }
}

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