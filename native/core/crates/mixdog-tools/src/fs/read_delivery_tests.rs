//! The decided changes to `read`'s delivery, asserted on the source text the model receives.
//!
//! 1. A batch's windows are rendered and charged by their requested intervals, never by the span between them; what truly
//!    overflows the call's budget ends on a complete row, and each incomplete window says which lines are missing and the
//!    call that fetches them.
//! 2. An explicit `read` returns the requested body, never a `[file unchanged]` receipt.
//!
//! Neither is a Node recording (Node merged windows up to 256 lines apart and answered repeats with a stub); the recorded
//! cases they displace are listed in `BUDGET_DEPARTURES` and `STUB_DEPARTURES`.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use super::*;

async fn workspace(seeds: Vec<(&str, Vec<u8>)>) -> (tempfile::TempDir, ToolContext) {
    let (dir, root) = small_dir();
    let ctx = context_seeded(&root, local_ctx_files(), seeds.into_iter().map(|(name, bytes)| (name.to_owned(), bytes)).collect()).await;
    (dir, ctx)
}

async fn run(tool: &ReadTool, ctx: &ToolContext, input: JsonValue) -> String {
    text_of(tool.call(ctx, input).await).1
}

fn has_row(out: &str, row: &str) -> bool {
    out.lines().any(|l| l == row)
}

fn lines(count: u64, row: impl Fn(u64) -> String) -> Vec<u8> {
    (1..=count).map(|i| format!("{}\n", row(i))).collect::<String>().into_bytes()
}

fn utf16(text: &[u8]) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for unit in String::from_utf8(text.to_vec()).unwrap().encode_utf16() {
        out.extend(unit.to_le_bytes());
    }
    out
}

/// The window of `file` from line `offset` (1-based) for `limit` lines.
fn win(file: &str, offset: u64, limit: u64) -> JsonValue {
    serde_json::json!({ "file_path": file, "offset": offset, "limit": limit })
}

fn small() -> Vec<u8> {
    lines(3, |i| format!("a{i}"))
}

/// Reads `requests` as one batch and follows every "re-read this file with offset:O limit:L" statement of each answer, as a
/// model would, until none is left. Returns, per file, the row numbers delivered whole (`row` captures the number).
async fn follow_to_completion(ctx: &ToolContext, requests: Vec<JsonValue>, row: &str) -> BTreeMap<String, BTreeSet<u64>> {
    let note = regex::Regex::new(r"re-read this file with offset:(\d+) limit:(\d+)").unwrap();
    let header = regex::Regex::new(r"^(\S+\.txt) \[ok\]").unwrap();
    let row = regex::Regex::new(row).unwrap();
    let tool = ReadTool::new(None, None);
    let mut delivered: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
    let mut requests = requests;
    for _ in 0..40 {
        // A second entry keeps every round a batch.
        let mut batch = requests.clone();
        batch.push(win("a.txt", 1, 3));
        let out = run(&tool, ctx, serde_json::json!({ "file_path": batch })).await;
        let (mut file, mut next) = (String::new(), Vec::new());
        for line in out.lines() {
            if let Some(c) = header.captures(line) {
                file = c[1].to_owned();
                continue;
            }
            if let Some(c) = row.captures(line) {
                delivered.entry(file.clone()).or_default().insert(c[1].parse().unwrap());
            }
            if let Some(c) = note.captures(line) {
                next.push(win(&file, c[1].parse().unwrap(), c[2].parse().unwrap()));
            }
        }
        if next.is_empty() {
            return delivered;
        }
        requests = next;
    }
    panic!("a remaining interval was never delivered");
}

fn all(range: std::ops::RangeInclusive<u64>) -> BTreeSet<u64> {
    range.collect()
}

#[tokio::test]
async fn batch_windows_separated_by_long_lines_do_not_pay_for_the_gap() {
    let file = lines(110, |i| if (6..100).contains(&i) { format!("g{i}-{}", "x".repeat(1500)) } else { format!("s{i}") });
    let (_dir, ctx) = workspace(vec![("f.txt", file)]).await;
    let out = run(&ReadTool::new(None, None), &ctx, serde_json::json!({ "file_path": [win("f.txt", 1, 5), win("f.txt", 100, 5)] })).await;
    for n in (1..=5).chain(100..=104) {
        assert!(has_row(&out, &format!("s{n}")), "row {n} missing:\n{out}");
    }
    assert!(!out.contains("NOT returned") && !out.contains("g50-"), "{out}");
}

#[tokio::test]
async fn batch_windows_that_overlap_repeat_or_arrive_unsorted_are_all_delivered() {
    let (_dir, ctx) = workspace(vec![("f.txt", lines(30, |i| format!("s{i}")))]).await;
    let windows = [win("f.txt", 20, 5), win("f.txt", 3, 4), win("f.txt", 5, 4), win("f.txt", 3, 4)];
    let out = run(&ReadTool::new(None, None), &ctx, serde_json::json!({ "file_path": windows })).await;
    for n in (3..=8).chain(20..=24) {
        assert!(has_row(&out, &format!("s{n}")), "row {n} missing:\n{out}");
    }
    assert!(!out.contains("NOT returned"), "{out}");
    let at = |row: &str| out.lines().position(|l| l == row).unwrap();
    assert!(at("s20") < at("s3"), "the entries keep the order they were requested in:\n{out}");
}

#[tokio::test]
async fn batch_windows_of_files_of_unequal_size_overflow_and_every_remainder_can_be_followed() {
    let seeds = vec![
        ("a.txt", small()),
        ("big1.txt", lines(600, |i| format!("r{i:04}-{}", "y".repeat(194)))),
        ("big2.txt", lines(150, |i| format!("r{i:04}-{}", "y".repeat(194)))),
    ];
    let (_dir, ctx) = workspace(seeds).await;
    let requests = vec![win("big1.txt", 1, 600), win("big2.txt", 1, 150), win("a.txt", 1, 3)];
    let first = run(&ReadTool::new(None, None), &ctx, serde_json::json!({ "file_path": requests.clone() })).await;
    assert!(has_row(&first, "a1") && has_row(&first, "a3"), "the short window is delivered whole:\n{first}");
    assert!(first.matches("re-read this file with offset:").count() >= 2, "each incomplete window names its remainder:\n{first}");
    let delivered = follow_to_completion(&ctx, requests, r"^r(\d{4})-y{194}$").await;
    assert_eq!(delivered["big1.txt"], all(1..=600));
    assert_eq!(delivered["big2.txt"], all(1..=150));
}

#[tokio::test]
async fn batch_windows_overlapping_past_the_budget_are_followed_to_completion() {
    let seeds = vec![("a.txt", small()), ("big.txt", lines(600, |i| format!("r{i:04}-{}", "y".repeat(194))))];
    let (_dir, ctx) = workspace(seeds).await;
    let requests = vec![win("big.txt", 1, 400), win("big.txt", 200, 400)];
    let first = run(&ReadTool::new(None, None), &ctx, serde_json::json!({ "file_path": requests.clone() })).await;
    assert!(first.contains("NOT returned") && first.contains("re-read this file with offset:"), "{first}");
    let delivered = follow_to_completion(&ctx, requests, r"^r(\d{4})-y{194}$").await;
    assert_eq!(delivered["big.txt"], all(1..=599));
}

#[tokio::test]
async fn batch_windows_of_utf8_text_end_on_whole_rows() {
    let row = |i: u64| format!("r{i:04}-{}", "é".repeat(300));
    let (_dir, ctx) = workspace(vec![("a.txt", small()), ("u8.txt", lines(300, row))]).await;
    let delivered = follow_to_completion(&ctx, vec![win("u8.txt", 1, 300)], r"^r(\d{4})-é{300}$").await;
    assert_eq!(delivered["u8.txt"], all(1..=300));
}

#[tokio::test]
async fn batch_windows_of_utf16_text_end_on_whole_rows() {
    let row = |i: u64| format!("r{i:04}-{}", "é".repeat(300));
    let (_dir, ctx) = workspace(vec![("a.txt", small()), ("u16.txt", utf16(&lines(300, row)))]).await;
    let first = run(&ReadTool::new(None, None), &ctx, serde_json::json!({ "file_path": [win("u16.txt", 1, 300), win("a.txt", 1, 3)] })).await;
    assert!(first.contains("re-read this file with offset:"), "a UTF-16 window cut by the budget names its remainder:\n{first}");
    let delivered = follow_to_completion(&ctx, vec![win("u16.txt", 1, 300)], r"^r(\d{4})-é{300}$").await;
    assert_eq!(delivered["u16.txt"], all(1..=300));
}

#[tokio::test]
async fn an_explicit_read_returns_its_body_whatever_the_session_has_seen() {
    let content = b"l1\nl2\nl3\nl4\n".to_vec();
    let (_dir, mut ctx) = workspace(vec![("a.txt", content.clone()), ("b.txt", content)]).await;
    let state = Arc::new(ReadState::new(None));
    let read = ReadTool::new(None, None).with_state(Arc::clone(&state));
    let edit = EditTool::new().with_state(Arc::clone(&state));
    ctx.thread_id = ThreadId::from("s1");
    let whole = |out: &str, rows: &[&str]| rows.iter().all(|r| has_row(out, r)) && !out.starts_with("[file unchanged");
    let full = serde_json::json!({ "file_path": "a.txt" });

    assert!(whole(&run(&read, &ctx, full.clone()).await, &["l1", "l2", "l3", "l4"]));
    assert!(whole(&run(&read, &ctx, full.clone()).await, &["l1", "l2", "l3", "l4"]), "a repeated read");
    let two = run(&read, &ctx, serde_json::json!({ "file_path": "a.txt", "limit": 2 })).await;
    assert!(whole(&two, &["l1", "l2"]) && !has_row(&two, "l3"), "a changed limit: {two}");
    let from3 = run(&read, &ctx, serde_json::json!({ "file_path": "a.txt", "offset": 3, "limit": 1 })).await;
    assert!(whole(&from3, &["l3"]) && !has_row(&from3, "l1"), "a changed offset: {from3}");
    let tail = run(&read, &ctx, serde_json::json!({ "file_path": "a.txt", "mode": "tail", "n": 1 })).await;
    assert!(tail.contains("l4") && !tail.starts_with("[file unchanged"), "a tail: {tail}");

    run(&read, &ctx, serde_json::json!({ "file_path": "b.txt", "limit": 2 })).await;
    assert!(whole(&run(&read, &ctx, serde_json::json!({ "file_path": "b.txt" })).await, &["l1", "l2", "l3", "l4"]), "after a partial delivery");

    edit.call(&ctx, serde_json::json!({ "file_path": "a.txt", "old_string": "l2", "new_string": "L2" })).await.unwrap();
    let edited = run(&read, &ctx, full.clone()).await;
    assert!(whole(&edited, &["l1", "L2", "l3", "l4"]) && !has_row(&edited, "l2"), "read, edit, read: {edited}");
    assert!(whole(&run(&read, &ctx, full.clone()).await, &["l1", "L2", "l3", "l4"]), "and again after the edit's own read");

    state.forget_snapshots("s1");
    assert!(whole(&run(&read, &ctx, full.clone()).await, &["l1", "L2", "l3", "l4"]), "after compaction");
    ctx.thread_id = ThreadId::from("s2");
    assert!(whole(&run(&read, &ctx, full.clone()).await, &["l1", "L2", "l3", "l4"]), "in another session");
    assert!(whole(&run(&ReadTool::new(None, None), &ctx, full).await, &["l1", "L2", "l3", "l4"]), "in a separate agent");
}

fn claims_any_of(snapshot: Option<crate::fs::read_state::Snapshot>, lines: std::ops::RangeInclusive<u64>) -> bool {
    snapshot.is_some_and(|s| s.ranges.iter().any(|r| r.start <= *lines.end() && r.end.is_none_or(|e| e >= *lines.start())))
}

/// Many windows shrink each share below one row of the UTF-16 file's two touching windows (the public form counts distinct
/// files, not windows): the shared read emits no row, so neither window is delivered, reported or recorded; each says to
/// read its range separately.
#[tokio::test]
async fn batch_windows_whose_shared_read_emitted_no_row_are_not_delivered_or_recorded() {
    let wide = |i: u64| format!("r{i:04}-{}", "é".repeat(1500));
    let seeds = vec![("u16.txt", utf16(&lines(4, wide))), ("f00.txt", lines(300, |i| format!("r{i:04}-{}", "y".repeat(1500))))];
    let (_dir, mut ctx) = workspace(seeds).await;
    ctx.thread_id = ThreadId::from("zr");
    let state = Arc::new(ReadState::new(None));
    let read = ReadTool::new(None, None).with_state(Arc::clone(&state));
    let mut requests = vec![win("u16.txt", 1, 2), win("u16.txt", 3, 2)];
    // One line every third line: no two windows touch, so each is a read of its own with its own share.
    requests.extend((0..100).map(|k| win("f00.txt", 3 * k + 1, 1)));
    let out = run(&read, &ctx, serde_json::json!({ "file_path": requests })).await;
    let missing = "output budget ended before its first row; read this range separately with offset:";
    assert!(out.contains(&format!("(lines 1-2 were NOT returned — the shared read's {missing}1 limit:2)")), "{out}");
    assert!(out.contains(&format!("(lines 3-4 were NOT returned — the shared read's {missing}3 limit:2)")), "{out}");
    assert!(!out.contains("r0001-é"), "no row of the starved read is delivered:\n{out}");
    let key = read_state_key(&ctx.cwd.as_path().join("u16.txt"));
    assert!(!claims_any_of(state.snapshot(Some("zr"), &key), 1..=4), "nothing was delivered, so nothing is recorded");
    let alone = run(&read, &ctx, serde_json::json!({ "file_path": "u16.txt", "offset": 1, "limit": 2 })).await;
    assert!(has_row(&alone, &wide(1)) && has_row(&alone, &wide(2)), "the separate read delivers the range");
}

/// A glob in a string batch (the executor's `path` spelling, which has no file cap) is rendered again inside a smaller share
/// when the batch overflows; what the session records for the files it matched comes from the rendering that is delivered,
/// which here holds no row.
#[tokio::test]
async fn a_nested_glob_in_a_string_batch_records_only_what_was_delivered() {
    let wide = |i: u64| format!("r{i:04}-{}", "y".repeat(1500));
    let names: Vec<String> = (0..60).map(|n| format!("f{n:02}.txt")).collect();
    let mut seeds: Vec<(&str, Vec<u8>)> = ["g/a.txt", "g/b.txt", "g/c.txt"].into_iter().map(|n| (n, lines(3, wide))).collect();
    seeds.extend(names.iter().map(|n| (n.as_str(), lines(3, wide))));
    let (_dir, mut ctx) = workspace(seeds).await;
    ctx.thread_id = ThreadId::from("zg");
    let state = Arc::new(ReadState::new(None));
    let read = ReadTool::new(None, None).with_state(Arc::clone(&state));
    let mut paths = vec!["g/*.txt".to_owned()];
    paths.extend(names);
    let out = run(&read, &ctx, serde_json::json!({ "path": paths })).await;
    assert!(out.contains("g/*.txt [ok]") && !out.contains("r0001-y"), "the starved renderings deliver no row:\n{out}");
    for file in ["g/a.txt", "g/b.txt", "g/c.txt"] {
        let key = read_state_key(&ctx.cwd.as_path().join(file));
        assert!(!claims_any_of(state.snapshot(Some("zg"), &key), 1..=3), "{file} was recorded as read though no row was delivered");
    }
}

#[tokio::test]
async fn a_window_that_ends_with_the_file_does_not_offer_more() {
    let (_dir, ctx) = workspace(vec![("n.txt", lines(9, |i| format!("row {i}")))]).await;
    let read = ReadTool::new(None, None);
    let tail = run(&read, &ctx, serde_json::json!({ "file_path": "n.txt", "tail": 2 })).await;
    assert!(!tail.contains("for more"), "{tail}");
    let inner = run(&read, &ctx, serde_json::json!({ "file_path": "n.txt", "offset": 6, "limit": 2 })).await;
    assert!(inner.contains("offset:8 for more"), "{inner}");
}

#[tokio::test]
async fn a_byte_capped_text_window_marks_only_the_partial_answers_incomplete() {
    let cap = super::super::common::output_max_bytes();
    let (_dir, ctx) = workspace(vec![("long.txt", format!("first row\n{}\n", "x".repeat(cap)).into_bytes())]).await;
    let read = ReadTool::new(None, None);
    for input in [
        serde_json::json!({ "file_path": "long.txt", "offset": 1, "limit": 2, "full": true }),
        serde_json::json!({ "file_path": [{"file_path": "long.txt", "offset": 1, "limit": 2}], "full": true }),
    ] {
        let out = read.call(&ctx, input).await.unwrap();
        assert_eq!(out.meta.as_ref().map(|m| &m["complete"]), Some(&JsonValue::Bool(false)));
        let text = text_of(Ok(out)).1;
        assert!(has_row(&text, "first row") && text.contains("output capped"), "{text}");
    }
    let out = read.call(&ctx, serde_json::json!({ "file_path": "long.txt", "offset": 1, "limit": 1 })).await.unwrap();
    assert!(out.meta.is_none(), "the requested window was fully delivered");
}

#[tokio::test]
async fn a_glob_tail_selects_the_end_of_each_file() {
    let (_dir, ctx) = workspace(vec![("a.log", b"a1\na2\na3\n".to_vec()), ("b.log", b"b1\nb2\nb3\nb4".to_vec())]).await;
    let out = run(&ReadTool::new(None, None), &ctx, serde_json::json!({ "file_path": "*.log", "tail": 2, "limit": 1 })).await;
    assert!(out.contains("a.log [ok]\n[lines 2-3]\na2\na3"), "{out}");
    assert!(out.contains("b.log [ok]\n[lines 3-4]\nb3\nb4"), "{out}");
    assert!(!has_row(&out, "a1") && !has_row(&out, "b2") && !out.contains("for more"), "{out}");
}

#[tokio::test]
async fn public_large_tails_mark_omitted_rows_without_marking_a_complete_suffix() {
    let mut content = b"earlier row\n".repeat(900_000);
    content.extend_from_slice(b"last row\n");
    let (_dir, ctx) = workspace(vec![("large.txt", content)]).await;
    let read = ReadTool::new(None, None);
    let whole = read.call(&ctx, serde_json::json!({ "file_path": "large.txt", "tail": 1 })).await.unwrap();
    assert!(whole.meta.is_none());
    assert!(has_row(&text_of(Ok(whole)).1, "last row"));
    for input in [
        serde_json::json!({ "file_path": "large.txt", "tail": 2001 }),
        serde_json::json!({ "file_path": [{ "file_path": "large.txt", "tail": 400 }] }),
    ] {
        let exceeds_row_limit = input["tail"].as_u64() == Some(2001);
        let part = read.call(&ctx, input).await.unwrap();
        assert_eq!(part.meta.as_ref().and_then(|meta| meta["complete"].as_bool()), Some(false));
        let text = text_of(Ok(part)).1;
        assert!(text.contains("last row") && text.contains("output budget omitted text"), "{text}");
        if exceeds_row_limit {
            assert!(text.contains("request capped at 2000 lines"), "{text}");
        }
    }
}

#[tokio::test]
async fn a_tail_on_a_coordinate_path_uses_the_end_of_the_resolved_file() {
    let (_dir, ctx) = workspace(vec![("a.log", b"first\nsecond\nthird\nlast\n".to_vec())]).await;
    let out = run(&ReadTool::new(None, None), &ctx, serde_json::json!({ "file_path": "a.log:2", "tail": 2 })).await;
    assert_eq!(out, "[lines 3-4]\nthird\nlast\n[lines 3-4 of 4]");
}

#[tokio::test]
async fn a_utf16_tail_counts_decoded_lines_not_lf_bytes_or_bom() {
    let (_dir, ctx) = workspace(vec![("notes.txt", utf16("first\u{010a}\nsecond\nthird\n".as_bytes()))]).await;
    let text = run(&ReadTool::new(None, None), &ctx, serde_json::json!({ "file_path": "notes.txt", "tail": 2 })).await;
    assert_eq!(text, "[lines 2-3]\nsecond\nthird\n[lines 2-3 of 3]");
}

#[tokio::test]
async fn a_read_glob_keeps_the_ten_newest_matches_and_reports_the_omission() {
    let names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt", "h.txt", "i.txt", "j.txt", "z.txt"];
    let seeds = names.iter().map(|&name| (name, format!("row for {name}\n").into_bytes())).collect();
    let (_dir, ctx) = workspace(seeds).await;
    for (i, name) in names.iter().enumerate() {
        let file = std::fs::File::options().write(true).open(ctx.cwd.as_path().join(name)).unwrap();
        let seconds = 1_700_000_000 + 60 * if *name == "b.txt" { 0 } else { i as u64 + 1 };
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds)).unwrap();
    }
    let out = ReadTool::new(None, None).call(&ctx, serde_json::json!({ "file_path": "*.txt" })).await.unwrap();
    assert_eq!(out.meta.as_ref().unwrap()["complete"], false);
    let text = text_of(Ok(out)).1;
    let delivered: Vec<_> = text.lines().filter_map(|line| line.strip_prefix("row for ")).collect();
    assert_eq!(delivered, ["z.txt", "j.txt", "i.txt", "h.txt", "g.txt", "f.txt", "e.txt", "d.txt", "c.txt", "a.txt"]);
    assert!(text.contains("glob expansion capped at 10 files"), "{text}");
}

#[tokio::test]
async fn a_batch_with_a_missing_target_keeps_the_successful_window_and_is_incomplete() {
    let (_dir, ctx) = workspace(vec![("good.txt", b"delivered row\n".to_vec())]).await;
    let input = serde_json::json!({ "file_path": ["good.txt", "missing.txt"] });
    let out = ReadTool::new(None, None).call(&ctx, input).await.unwrap();
    assert_eq!(out.meta.as_ref().unwrap()["complete"], false);
    let text = text_of(Ok(out)).1;
    assert!(text.contains("good.txt [ok]\n[lines 1-1]\ndelivered row"), "{text}");
    assert!(text.lines().any(|line| line.starts_with("missing.txt [absent]") || line.starts_with("missing.txt [error]")), "{text}");
}
