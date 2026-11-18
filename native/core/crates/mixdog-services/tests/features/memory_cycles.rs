//! The memory cycle's rules that need no database: intervals, the due rule, request signatures and how the
//! classifier's reply is read and checked.

use mixdog_services::memory::cycles::quality::{Row, parse_cycle1_line_format, validate_cycle1_grouping};
use mixdog_services::memory::cycles::signature::{make_cycle_request_signature, parse_interval, periodic_cycle_due, scheduled_cycle1_signature};
use serde_json::json;

// ---- intervals and the due rule ----

#[test]
fn an_interval_is_a_number_and_a_unit() {
    for (text, ms) in [("500ms", 500.0), ("500 ms", 500.0), ("30s", 30_000.0), ("10m", 600_000.0), ("1.5h", 5_400_000.0), (" 2d ", 172_800_000.0)] {
        assert_eq!(parse_interval(&json!(text)).unwrap(), ms, "{text}");
    }
}

#[test]
fn anything_else_is_an_invalid_interval_that_names_the_value() {
    for bad in [json!("10"), json!("m"), json!("-5m"), json!("1w"), json!(""), json!("1.m"), json!(null)] {
        let message = parse_interval(&bad).unwrap_err().message();
        assert!(message.contains("[memory-cycle] invalid interval config: "), "{bad}: {message}");
    }
    assert!(parse_interval(&json!("1y")).unwrap_err().message().ends_with("invalid interval config: 1y"));
}

#[test]
fn a_cycle_is_due_one_interval_after_its_last_run_or_after_the_cycles_started() {
    // Last run at 1000, interval 500.
    assert!(!periodic_cycle_due(1000.0, 0.0, 500.0, 1499.0));
    assert!(periodic_cycle_due(1000.0, 0.0, 500.0, 1500.0));
    // Never run: the clock starts when the cycles started.
    assert!(!periodic_cycle_due(0.0, 2000.0, 500.0, 2499.0));
    assert!(periodic_cycle_due(0.0, 2000.0, 500.0, 2500.0));
    // An unreadable last run counts as never; an interval of zero never fires.
    assert!(periodic_cycle_due(f64::NAN, 2000.0, 500.0, 2500.0));
    assert!(!periodic_cycle_due(0.0, 0.0, 0.0, 1e12));
}

#[test]
fn equal_requests_have_equal_signatures_whatever_the_key_order() {
    let a = make_cycle_request_signature(&[json!("cycle1"), json!({"x": 1, "y": {"b": 2, "a": 1}})]);
    let b = make_cycle_request_signature(&[json!("cycle1"), json!({"y": {"a": 1, "b": 2}, "x": 1})]);
    assert_eq!(a, b);
    assert_ne!(a, make_cycle_request_signature(&[json!("cycle1"), json!({"x": 2, "y": {"a": 1, "b": 2}})]));
    assert_ne!(a, make_cycle_request_signature(&[json!("cycle2"), json!({"x": 1, "y": {"a": 1, "b": 2}})]));
    assert_eq!(scheduled_cycle1_signature(&json!({"k": 1})), scheduled_cycle1_signature(&json!({"k": 1})));
    assert_ne!(scheduled_cycle1_signature(&json!({"k": 1})), scheduled_cycle1_signature(&json!({"k": 2})));
}

// ---- the classifier's reply ----

fn row(id: i64, session: &str) -> Row {
    Row { id, ts: 1_700_000_000_000 + id, role: Some("user".into()), content: format!("row {id}"), session_id: Some(session.into()), project_id: None, element: None }
}

#[test]
fn a_reply_line_is_member_numbers_element_category_and_summary() {
    let parsed = parse_cycle1_line_format("1-3,5 | Build | Decision | Use the cache\n\n  7|Deploy|FACT|a | b  ").unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].idx_list, [1, 2, 3, 5]);
    assert_eq!((parsed[0].element.as_str(), parsed[0].category.as_str(), parsed[0].summary.as_str()), ("Build", "decision", "Use the cache"));
    assert_eq!((parsed[1].idx_list.clone(), parsed[1].category.as_str(), parsed[1].summary.as_str()), (vec![7], "fact", "a | b"));
}

#[test]
fn a_reply_line_that_is_not_in_the_format_is_marked_not_dropped() {
    let parsed = parse_cycle1_line_format("1|only|three\nnot a list|a|b|c\n1|ok|rule|fine").unwrap();
    assert_eq!(parsed.len(), 3);
    assert_eq!((parsed[0].parse_error, parsed[1].parse_error, parsed[2].parse_error), (Some("invalid_line_format"), Some("invalid_line_format"), None));
    assert_eq!(parse_cycle1_line_format("  \n "), None);
    assert_eq!(parse_cycle1_line_format(""), None);
}

#[test]
fn a_member_range_that_runs_backwards_or_is_absurdly_long_selects_nothing_valid() {
    for line in ["5-2|e|rule|s", "1-5000|e|rule|s"] {
        assert_eq!(parse_cycle1_line_format(line).unwrap()[0].idx_list, [0], "{line}");
    }
}

#[test]
fn a_grouping_is_valid_when_every_row_is_in_exactly_one_complete_chunk_of_one_session() {
    let rows = [row(10, "a"), row(11, "a"), row(12, "b")];
    let chunks = parse_cycle1_line_format("1-2|Build|decision|Cache it\n3|Ops|task|Deploy").unwrap();
    let verdict = validate_cycle1_grouping(Some(&chunks), &rows);
    assert!(verdict.valid && verdict.errors.is_empty() && verdict.omitted.is_empty());
    assert_eq!(verdict.accepted.len(), 2);
}

#[test]
fn each_way_a_chunk_can_be_wrong_is_named_and_the_rows_it_leaves_are_omitted() {
    let rows = [row(10, "a"), row(11, "a"), row(12, "b")];
    let cases = [
        ("9|e|rule|s", "out_of_range_idx", vec![1, 2, 3]),
        ("1|e|rule|s\n1-2|e|rule|s", "duplicate_member_ids", vec![1, 2, 3]),
        ("1|e|nonsense|s\n2|e|rule|s\n3|e|rule|s", "incomplete_fields", vec![1]),
        ("1|e|rule|\n2|e|rule|s\n3|e|rule|s", "incomplete_fields", vec![1]),
        ("1|e|rule|s\n2-3|e|rule|s", "mixed_sessions", vec![2, 3]),
        ("oops", "invalid_line_format", vec![1, 2, 3]),
    ];
    for (reply, reason, omitted) in cases {
        let chunks = parse_cycle1_line_format(reply).unwrap();
        let verdict = validate_cycle1_grouping(Some(&chunks), &rows);
        assert!(!verdict.valid, "{reply}");
        assert!(verdict.errors.iter().any(|e| e == reason), "{reply}: {:?}", verdict.errors);
        assert!(verdict.invalid.iter().any(|i| i.reason == reason), "{reply}");
        assert_eq!(verdict.omitted, omitted, "{reply}");
        assert!(omitted.is_empty() || verdict.errors.contains(&"omitted_rows".to_owned()), "{reply}");
    }
}

#[test]
fn no_reply_at_all_is_not_a_valid_grouping() {
    let verdict = validate_cycle1_grouping(None, &[row(1, "a")]);
    assert!(!verdict.valid);
    assert_eq!(verdict.omitted, [1]);
}
