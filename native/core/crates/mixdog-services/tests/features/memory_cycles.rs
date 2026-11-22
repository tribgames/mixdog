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
    Row {
        id,
        ts: 1_700_000_000_000 + id,
        role: Some("user".into()),
        content: format!("row {id}"),
        session_id: Some(session.into()),
        project_id: None,
        element: None,
    }
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

#[tokio::test]
async fn a_line_repeated_word_for_word_is_read_once() {
    let rows = [big_row("word ".repeat(400))];
    let (generated, calls) = generate(&rows, 16_000.0, |_| "1|Plan|task|decided\n 1 | Plan | Task | decided ".into()).await;
    assert_eq!(calls.len(), 1);
    assert!(generated.invalid_chunks.is_empty(), "{:?}", generated.invalid_chunks);
    assert_eq!(generated.chunks.len(), 1);
    assert_eq!(generated.chunks[0].summary, "decided");
    assert!(generated.raw_row_ids.is_empty());
}

#[test]
fn lines_that_differ_over_a_row_or_name_a_row_not_given_are_not_repaired() {
    let rows = [row(10, "a"), row(11, "a"), row(12, "a")];
    let shared = parse_cycle1_line_format("1,2|Build|task|Fix the build\n2,3|Release|decision|Defer the release").unwrap();
    let verdict = validate_cycle1_grouping(Some(&shared), &rows);
    assert!(verdict.accepted.is_empty());
    assert_eq!(verdict.invalid.iter().map(|i| i.reason.as_str()).collect::<Vec<_>>(), ["duplicate_member_ids", "duplicate_member_ids"]);
    // Only the rows the failing lines name fail.
    let partly = parse_cycle1_line_format("1|Build|task|Fix the build\n2,3|Release|decision|Defer\n3|Release|fact|Deferred").unwrap();
    let verdict = validate_cycle1_grouping(Some(&partly), &rows);
    assert_eq!(verdict.accepted.iter().map(|c| c.idx_list.clone()).collect::<Vec<_>>(), [vec![1]]);
    assert_eq!(verdict.omitted, [2, 3]);
    for reply in ["2|Deploy|fact|Production deployment succeeded", "3-2|Deploy|fact|s", "1,3|Deploy|fact|s"] {
        let verdict = validate_cycle1_grouping(Some(&parse_cycle1_line_format(reply).unwrap()), &rows[..1]);
        assert!(verdict.accepted.is_empty(), "{reply}");
        assert_eq!(verdict.invalid[0].reason, "out_of_range_idx", "{reply}");
    }
}

#[test]
fn no_reply_at_all_is_not_a_valid_grouping() {
    let verdict = validate_cycle1_grouping(None, &[row(1, "a")]);
    assert!(!verdict.valid);
    assert_eq!(verdict.omitted, [1]);
}

// ---- prompt measure and the minimum window ----

fn big_row(content: String) -> Row {
    Row { content, ..row(1, "s") }
}

struct Script {
    calls: std::sync::Mutex<Vec<String>>,
    reply: fn(&str) -> String,
}

#[async_trait::async_trait]
impl mixdog_services::memory::cycles::Cycle1Llm for Script {
    async fn call(&self, _: &mixdog_services::memory::cycles::Cycle1Request, _: &tokio_util::sync::CancellationToken, prompt: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(prompt.to_owned());
        Ok((self.reply)(prompt))
    }
}

async fn generate(rows: &[Row], input_budget: f64, reply: fn(&str) -> String) -> (mixdog_services::memory::cycles::quality::Generated, Vec<String>) {
    use mixdog_services::memory::cycles::Cycle1Request;
    use mixdog_services::memory::cycles::quality::{Generation, generate_cycle1_chunks};
    let llm = Script { calls: Default::default(), reply };
    let request = Cycle1Request { preset: None, timeout_ms: 1000.0 };
    let cancel = tokio_util::sync::CancellationToken::new();
    let now = || 0i64;
    let ctx = Generation { llm: &llm, request: &request, cancel: &cancel, input_token_budget: input_budget, now: &now };
    let generated = generate_cycle1_chunks(rows, &ctx).await.unwrap();
    let calls = llm.calls.lock().unwrap().clone();
    (generated, calls)
}

fn source_tokens_of(rows: &[Row]) -> f64 {
    mixdog_js::token_estimate::estimate_tokens(&mixdog_services::memory::cycles::quality::chunk_source_text(rows)) as f64
}

#[test]
fn splitting_and_packing_budget_the_prompt_that_is_sent() {
    use mixdog_services::memory::cycles::quality::{partition_cycle1_rows, prompt_tokens, split_cycle1_row};
    let (budget, limit) = (5000.0, 7048.0);
    let one = big_row("a, ".repeat(6400));
    assert!(source_tokens_of(std::slice::from_ref(&one)) <= budget && prompt_tokens(std::slice::from_ref(&one), false) as f64 > limit);
    let fragments = split_cycle1_row(&one, budget).unwrap();
    assert!(fragments.len() > 1);
    assert!(fragments.iter().all(|f| prompt_tokens(std::slice::from_ref(f), false) as f64 <= limit));
    let rows: Vec<Row> = (1..=12).map(|i| Row { content: "a, ".repeat(1000), ..row(i, "s") }).collect();
    let packets = partition_cycle1_rows(&rows, budget, 50);
    assert!(packets.len() > 1);
    assert!(packets.iter().all(|p| prompt_tokens(p, false) as f64 <= limit));
}

#[tokio::test]
async fn a_row_whose_source_fits_is_not_refused_at_the_call() {
    let rows = [big_row("a, ".repeat(6400))];
    let (generated, calls) = generate(&rows, 7048.0, |_| "1 | Topic | fact | short".into()).await;
    assert!(generated.invalid_chunks.iter().all(|c| c.reason != "llm_error"), "{:?}", generated.invalid_chunks);
    assert!(calls.len() > 1, "a prompt over the input limit is split");
}

#[tokio::test]
async fn a_row_that_fits_the_call_is_not_fragmented_for_the_reserve() {
    use mixdog_services::memory::cycles::quality::prompt_tokens;
    let rows = [big_row("a, ".repeat(10500))];
    // Fits the source limit (12,000) and the call (14,048) although its prompt is above 12,000.
    assert!(source_tokens_of(&rows) <= 12_000.0 && prompt_tokens(&rows, false) as f64 > 12_000.0 && prompt_tokens(&rows, false) as f64 <= 14_048.0);
    let (generated, calls) = generate(&rows, 14_048.0, |_| "1 | Topic | fact | short".into()).await;
    assert_eq!(calls.len(), 1);
    assert_eq!(generated.chunks.len(), 1);
}

#[tokio::test]
async fn a_rewrite_that_cannot_be_sent_leaves_its_row_raw_and_keeps_the_other_summary() {
    let rows = [big_row("a,bcdef ".repeat(3900)), Row { content: "word ".repeat(2000), ..row(2, "s") }];
    {
        use mixdog_services::memory::cycles::quality::prompt_tokens;
        assert!(source_tokens_of(&rows) <= 12_000.0 && prompt_tokens(&rows, false) as f64 <= 14_048.0);
        assert!(prompt_tokens(&rows[..1], true) as f64 > 14_048.0, "a rewrite of the first row alone is over the input limit");
    }
    let (generated, calls) = generate(&rows, 14_048.0, |prompt| {
        if prompt.contains("Rewrite:") {
            "1 | Topic | fact | short".into()
        } else {
            format!("1 | Topic | fact | {}\n2 | Topic | fact | short", "x ".repeat(20_000))
        }
    })
    .await;
    assert!(generated.invalid_chunks.iter().all(|c| c.reason != "llm_error"), "{:?}", generated.invalid_chunks);
    assert_eq!(generated.chunks.len(), 1);
    assert_eq!(generated.chunks[0].members.iter().map(|m| m.id).collect::<Vec<_>>(), [2]);
    assert_eq!(generated.raw_row_ids, [1]);
    assert_eq!(
        calls.len(),
        1,
        "the oversize rewrite is not sent: {:?}",
        calls.iter().map(|c| (c.len(), c.lines().next().unwrap().to_owned())).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn a_rewrite_that_fits_is_sent_once_for_all_the_rows_that_need_it() {
    use mixdog_services::memory::cycles::quality::prompt_tokens;
    let rows = [
        big_row("a,bcdef ".repeat(3900)),
        Row { content: "word ".repeat(1600), ..row(2, "s") },
        Row { content: "word ".repeat(10), ..row(3, "s") },
        Row { content: "word ".repeat(1600), ..row(4, "s") },
    ];
    // Rows 1, 3 and 4 make one rewrite prompt, though rows 1 and 3 without the fourth are priced over the limit.
    let rewritten = [rows[0].clone(), rows[2].clone(), rows[3].clone()];
    assert!(prompt_tokens(&rewritten, true) as f64 <= 14_048.0 && prompt_tokens(&rewritten[..2], true) as f64 > 14_048.0);
    let (generated, calls) = generate(&rows, 14_048.0, |prompt| {
        if prompt.contains("Rewrite:") {
            "1 | First | fact | short\n2 | Third | fact | short\n3 | Fourth | fact | short".into()
        } else {
            format!("1 | First | fact | {long}\n2 | Second | fact | short\n3 | Third | fact | {long}\n4 | Fourth | fact | {long}", long = "x ".repeat(40_000))
        }
    })
    .await;
    assert_eq!(calls.len(), 2, "the first call, then one rewrite of rows 1, 3 and 4");
    assert!(calls[1].contains("Rewrite:") && calls[1].contains("@3 ") && !calls[1].contains("@4 "), "the rewrite numbers its three rows");
    let mut members: Vec<(String, Vec<i64>)> = generated.chunks.iter().map(|c| (c.element.clone(), c.members.iter().map(|m| m.id).collect())).collect();
    members.sort();
    assert_eq!(members, [("First".to_owned(), vec![1]), ("Fourth".to_owned(), vec![4]), ("Second".to_owned(), vec![2]), ("Third".to_owned(), vec![3])]);
}

#[test]
fn a_window_below_the_minimum_is_recognised_as_never_sent() {
    use mixdog_services::memory::cycles::quality::is_below_min_source;
    assert!(is_below_min_source(&[row(1, "s")]));
    assert!(!is_below_min_source(&[big_row("word ".repeat(100))]));
}
