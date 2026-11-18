//! grep continuation and path-list hints: what a capped answer promises, followed to the end, and what a joined-path hint
//! tells each tool's caller to do, run against the tool it names.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the tests build real work trees with blocking filesystem calls"
)]

use std::collections::BTreeMap;
use std::sync::Arc;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::JsonValue;

use super::common::grep_max_bytes;
use super::tests::{context_seeded, text_of};
use super::{GlobTool, GrepTool, ListTool};

async fn tree(files: Vec<(String, Vec<u8>)>) -> (tempfile::TempDir, ToolContext) {
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), files).await;
    (dir, ctx)
}

async fn grep(ctx: &ToolContext, input: JsonValue) -> String {
    let (failed, text) = text_of(GrepTool::new().call(ctx, input).await);
    assert!(!failed, "{text}");
    text
}

/// The offset the renderer's own paging notice names, if the answer continues.
fn cursor(text: &str) -> Option<usize> {
    static NOTICE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"offset:([0-9]+) for the rest\]").unwrap());
    NOTICE.captures_iter(text).last().map(|c| c[1].parse().unwrap())
}

/// Follows a single-section call's cursor to its end: every page within the cap, none carrying Node's cap footer; the pages.
async fn follow(ctx: &ToolContext, input: JsonValue) -> Vec<String> {
    let (mut pages, mut offset) = (Vec::new(), input["offset"].as_u64().unwrap_or(0) as usize);
    for _ in 0..200 {
        let mut call = input.clone();
        call["offset"] = JsonValue::from(offset);
        let text = grep(ctx, call).await;
        assert!(text.len() <= grep_max_bytes() + 400, "a page of {} bytes passes the cap", text.len());
        assert!(!text.contains("[output capped at") && !text.contains("narrow: run one pattern/path"), "{text}");
        let next = cursor(&text);
        pages.push(text);
        match next {
            Some(next) => {
                assert!(next > offset, "the cursor must advance past {offset}, was {next}");
                offset = next;
            }
            None => return pages,
        }
    }
    panic!("the cursor never ended");
}

fn lines(n: usize, pad: usize) -> Vec<u8> {
    (0..n).map(|i| format!("needle {i:04} {}\n", "p".repeat(pad))).collect::<String>().into_bytes()
}

/// Bare content (`context: 0`) with the default limit and with none: each page is a prefix of whole rows and the cursor names the
/// first row not shown, so following it to the end shows every row once, in order.
#[tokio::test]
async fn bare_content_followed_to_exhaustion_shows_every_row_once() {
    let (_dir, ctx) = tree(vec![("big.txt".to_owned(), lines(400, 80))]).await;
    for limit in [None, Some(0)] {
        let mut input = serde_json::json!({ "pattern": "needle", "path": "big.txt", "context": 0 });
        if let Some(limit) = limit {
            input["limit"] = JsonValue::from(limit);
        }
        let pages = follow(&ctx, input).await;
        assert!(pages.len() >= 2, "{limit:?}: 400 rows of ~95 bytes pass one page");
        let seen: Vec<usize> = pages.iter().flat_map(|p| p.lines().filter_map(|l| l.split_once("needle ").map(|(_, rest)| rest[..4].parse().unwrap()))).collect();
        assert_eq!(seen, (0..400).collect::<Vec<_>>(), "{limit:?}: nothing skipped, nothing repeated");
    }
}

/// Files mode and count mode: the units are file rows and count rows.
#[tokio::test]
async fn files_and_count_modes_followed_to_exhaustion_show_every_row_once() {
    let files = (0..200).map(|i| (format!("d/file_with_a_long_name_{i:03}.txt"), b"needle\n".to_vec())).collect();
    let (_dir, ctx) = tree(files).await;
    for mode in ["files", "count"] {
        let pages = follow(&ctx, serde_json::json!({ "pattern": "needle", "mode": mode, "path": "d", "limit": 0 })).await;
        assert!(pages.len() >= 2, "{mode}: 200 long rows pass one page");
        let mut rows = BTreeMap::new();
        for line in pages.iter().flat_map(|p| p.lines()) {
            if let Some(at) = line.find("file_with_a_long_name_") {
                *rows.entry(line[at..at + 25].to_owned()).or_insert(0) += 1;
            }
        }
        assert_eq!(rows.len(), 200, "{mode}: every file");
        assert!(rows.values().all(|n| *n == 1), "{mode}: no row twice");
    }
}

/// A fan-out whose first section alone passes the cap, and one over paths and patterns with a line two patterns match:
/// each section is delivered as whole results, the footer gives the exact call that continues, and the resumed call
/// restores the section header and goes on into the later sections. The union is the known result set.
#[tokio::test]
async fn a_capped_fan_out_followed_by_its_cursor_shows_every_result_of_every_section_once() {
    let a: String = (0..80).map(|i| format!("alpha beta a{i:03} {}\n", "p".repeat(70))).collect();
    let b: String = (0..80).map(|i| format!("alpha b{i:03} {}\n", "p".repeat(70))).collect();
    let (_dir, ctx) = tree(vec![("a/x.txt".to_owned(), a.into_bytes()), ("b/x.txt".to_owned(), b.into_bytes())]).await;
    for (patterns, expected_a, expected_b) in [(serde_json::json!("alpha"), 1, 1), (serde_json::json!(["alpha", "beta"]), 2, 1)] {
        let mut call = serde_json::json!({ "pattern": patterns, "path": ["a", "b"], "context": 0, "limit": 0 });
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut first_headers = Vec::new();
        let mut ended = false;
        for round in 0..60 {
            let text = grep(&ctx, call.clone()).await;
            assert!(text.len() <= grep_max_bytes() + 400, "round {round}: {} bytes", text.len());
            assert!(!text.contains("pass offset to page each section") && !text.contains("narrow: run one pattern/path per call"), "{text}");
            first_headers.push(text.lines().next().unwrap_or_default().to_owned());
            for word in text.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() == 4 && (w.starts_with('a') || w.starts_with('b')) && w[1..].bytes().all(|d| d.is_ascii_digit())) {
                *counts.entry(word.to_owned()).or_insert(0) += 1;
            }
            let Some((_, rest)) = text.rsplit_once("Continue with grep ") else {
                ended = true;
                break;
            };
            call = serde_json::from_str(rest.trim_end().trim_end_matches(']')).expect("the footer's call is JSON");
            assert!(call.get("section").is_some() && call.get("offset").is_some(), "{call}");
        }
        assert!(ended, "the cursor never ended");
        assert!(first_headers.iter().all(|h| h.starts_with("# grep ")), "every page restores its section header: {first_headers:?}");
        assert_eq!(counts.len(), 160, "every line of both files");
        for (id, n) in &counts {
            let want = if id.starts_with('a') { expected_a } else { expected_b };
            assert_eq!(*n, want, "{id} is in {want} section(s)");
        }
    }
}

/// Follows a fan-out's compound cursor to its end: the pages, each within the cap and none carrying Node's narrowing advice.
async fn follow_footers(ctx: &ToolContext, mut call: JsonValue) -> Vec<String> {
    let mut pages = Vec::new();
    for round in 0..60 {
        let text = grep(ctx, call.clone()).await;
        assert!(text.len() <= grep_max_bytes() + 400, "round {round}: {} bytes", text.len());
        assert!(!text.contains("pass offset to page each section") && !text.contains("narrow: run one pattern/path per call"), "{text}");
        let next = text.rsplit_once("Continue with grep ").map(|(_, rest)| rest.trim_end().trim_end_matches(']').to_owned());
        pages.push(text);
        match next {
            Some(rest) => call = serde_json::from_str(&rest).expect("the footer's call is JSON"),
            None => return pages,
        }
    }
    panic!("the cursor never ended");
}

/// How often each `id<file letter><3 digits>` token is shown across the pages.
fn token_counts(pages: &[String]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for page in pages {
        for word in page.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() == 6 && w.starts_with("id") && w[3..].bytes().all(|d| d.is_ascii_digit())) {
            *counts.entry(word.to_owned()).or_insert(0) += 1;
        }
    }
    counts
}

fn rows(file: char, n: usize, pad: usize) -> Vec<u8> {
    (0..n).map(|i| format!("needle id{file}{i:03} {}\n", "p".repeat(pad))).collect::<String>().into_bytes()
}

/// Several sections, the first holding more matches than `limit`, and the later output passing the cap: the cursor stops at
/// what the limit left behind, so following it shows every result once, none skipped between the sections.
#[tokio::test]
async fn a_section_cut_by_the_limit_is_continued_before_the_later_sections() {
    let files = vec![
        ("a/x.txt".to_owned(), rows('a', 12, 600)),
        ("b/x.txt".to_owned(), rows('b', 3, 600)),
        ("c/x.txt".to_owned(), rows('c', 3, 600)),
        ("d/x.txt".to_owned(), rows('d', 3, 600)),
    ];
    let (_dir, ctx) = tree(files).await;
    let pages = follow_footers(&ctx, serde_json::json!({ "pattern": "needle", "path": ["a", "b", "c", "d"], "context": 0, "limit": 5 })).await;
    assert!(pages.len() >= 3, "{} page(s): the answer passes the cap", pages.len());
    let counts = token_counts(&pages);
    assert_eq!(counts.len(), 21, "every row of every file: {counts:?}");
    assert!(counts.values().all(|n| *n == 1), "no row twice: {counts:?}");
}

/// Context blocks: a section whose blocks do not fit the context budget is cut to the first anchors that do, and its cursor
/// names the next one, so following the cursors shows every match once, none dropped between the sections. (A section the
/// renderer cut by its own budget used to leave the cursor at the section after it.)
#[tokio::test]
async fn a_context_section_cut_by_the_budget_is_continued_not_skipped() {
    // Sized from the cap. The renderer drops anchors until a section fits its share of the cap, but never below one anchor,
    // and one anchor's block holds its whole match line. Ten paths (the most a call takes) each with a match line longer
    // than a tenth of the cap leave an answer of at least ten such lines: over the cap whatever the renderer drops.
    let line = grep_max_bytes() / 10 + 200;
    assert!(10 * line > grep_max_bytes());
    let per_file = 8;
    let letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    let file = |f: char| -> Vec<u8> {
        (0..per_file)
            .map(|i| {
                let head = format!("hit id{f}{i:03} ");
                format!("{head}{}\n{}", "p".repeat(line - head.len()), "fill\n".repeat(39))
            })
            .collect::<String>()
            .into_bytes()
    };
    let files = letters.iter().map(|f| (format!("{f}/x.txt"), file(*f))).collect();
    let (_dir, ctx) = tree(files).await;
    let paths: Vec<String> = letters.iter().map(|f| f.to_string()).collect();
    let pages = follow_footers(&ctx, serde_json::json!({ "pattern": "hit", "path": paths })).await;
    let first = &pages[0];
    assert!(
        pages.len() > 1,
        "{} page(s): the answer passes the cap; first answer {} bytes (cap {}), head {:?}, tail {:?}",
        pages.len(),
        first.len(),
        grep_max_bytes(),
        &first[..first.len().min(300)],
        &first[first.len().saturating_sub(400)..]
    );
    let counts = token_counts(&pages);
    assert_eq!(counts.len(), letters.len() * per_file, "every match of every file");
    assert!(counts.values().all(|n| *n == 1), "no match twice: {counts:?}");
}

/// One section whose first match is too large for the cap and which has a small one after it: the answer names the large
/// match and gives the call that goes on after it, and that call delivers the small match once.
#[tokio::test]
async fn an_oversized_first_match_of_one_section_is_named_and_the_small_one_after_it_is_continued() {
    // A line the printer keeps whole (500 grapheme clusters) yet far over the cap: each cluster is a letter and 30 accents.
    let huge = format!("needle idz000 {}\n", format!("a{}", "\u{301}".repeat(30)).repeat(200));
    let content = format!("{huge}needle ids001 small\n").into_bytes();
    let (_dir, ctx) = tree(vec![("x.txt".to_owned(), content)]).await;
    let pages = follow_footers(&ctx, serde_json::json!({ "pattern": "needle", "path": "x.txt", "context": 0, "limit": 0 })).await;
    assert_eq!(pages.len(), 2, "{pages:?}");
    assert!(pages[0].contains("alone is larger than the") && pages[0].contains("Continue with grep"), "{}", pages[0]);
    assert!(!pages[0].contains("ids001") && pages[1].contains("ids001"), "the small match is in the page after the notice: {pages:?}");
    assert_eq!(pages.iter().filter(|p| p.contains("ids001")).count(), 1, "once");
}

/// A capped file list over several paths continues the answer the call gave: the combined scan's order (by path), not the
/// newest-first order of one path's own list, and every file once across the cursors.
#[tokio::test]
async fn a_capped_file_list_over_paths_keeps_the_combined_scans_order() {
    let names = |d: &str| (0..60).map(|i| format!("{d}/file_with_a_rather_long_name_{i:02}.txt")).collect::<Vec<_>>();
    let files = ["f1", "f2", "f3"].iter().flat_map(|d| names(d)).map(|n| (n, b"needle\n".to_vec())).collect();
    let (_dir, ctx) = tree(files).await;
    // Later names are newer, so a newest-first list would run backwards.
    let epoch = std::time::SystemTime::UNIX_EPOCH;
    for (at, name) in ["f1", "f2", "f3"].iter().flat_map(|d| names(d)).enumerate() {
        let file = std::fs::File::options().write(true).open(ctx.cwd.as_path().join(&name)).unwrap();
        file.set_modified(epoch + std::time::Duration::from_secs(1_000_000 + at as u64)).unwrap();
    }
    let pages = follow_footers(&ctx, serde_json::json!({ "pattern": "needle", "mode": "files", "path": ["f1", "f2", "f3"], "limit": 0 })).await;
    assert!(pages.len() >= 2, "{} page(s): 180 long rows pass the cap", pages.len());
    let shown: Vec<String> = pages.iter().flat_map(|p| p.lines()).filter(|l| l.contains("file_with_a_rather_long_name_")).map(|l| l.trim().to_owned()).collect();
    let expected: Vec<String> = ["f1", "f2", "f3"].iter().flat_map(|d| names(d)).collect();
    assert_eq!(shown, expected, "the files in the scan's order, each once");
}

/// A result too large for the cap in the middle of a fan-out is named and the call goes on: the cursor continues after it,
/// into the rest of its section and the later sections.
#[tokio::test]
async fn an_oversized_result_mid_fan_out_is_named_and_the_cursor_goes_on() {
    // A line the printer keeps whole (500 grapheme clusters) yet far over the cap: each cluster is a letter and 30 accents.
    let mut b = rows('b', 3, 100);
    b.splice(0..0, format!("needle idb999 {}\n", format!("a{}", "\u{301}".repeat(30)).repeat(200)).into_bytes());
    let files = vec![("a/x.txt".to_owned(), rows('a', 2, 100)), ("b/x.txt".to_owned(), b), ("c/x.txt".to_owned(), rows('c', 2, 100))];
    let (_dir, ctx) = tree(files).await;
    let pages = follow_footers(&ctx, serde_json::json!({ "pattern": "needle", "path": ["a", "b", "c"], "context": 0, "limit": 0 })).await;
    assert!(pages.iter().any(|p| p.contains("alone is larger than the")), "the large result is named: {pages:?}");
    let mut counts = token_counts(&pages);
    // The named result is read by its window (its own text may be named once); every other row is shown once, those after it
    // included.
    assert!(counts.remove("idb999").unwrap_or(1) <= 1);
    let expected: Vec<&str> = vec!["ida000", "ida001", "idb000", "idb001", "idb002", "idc000", "idc001"];
    assert_eq!(counts.keys().map(String::as_str).collect::<Vec<_>>(), expected, "{counts:?}");
    assert!(counts.values().all(|n| *n == 1), "no row twice: {counts:?}");
}

/// A result that alone passes the cap is named with the exact read, not skipped by a cursor.
#[test]
fn a_result_too_large_for_the_cap_is_named_and_no_cursor_skips_it() {
    let notice = super::search::oversize_notice(5120, 7, "src/big.rs:41:needle", Some(("src/big.rs".to_owned(), 41)));
    assert!(notice.contains("result 7 alone is larger") && notice.contains("src/big.rs:41"), "{notice}");
    assert!(notice.contains("\"file_path\":\"src/big.rs\"") && notice.contains("\"offset\":38"), "{notice}");
    assert!(!notice.contains("for the rest") && !notice.contains("section"), "{notice}");
}

/// A joined path list is repaired for the tool that printed it, and the repair runs: grep takes an array, list and glob one
/// base per call. A name that merely contains a space or a comma is no evidence of a list.
#[tokio::test]
async fn a_joined_path_list_is_repaired_for_the_tool_that_printed_it_and_the_repair_runs() {
    let (_dir, ctx) = tree(vec![("a/x.txt".to_owned(), b"x\n".to_vec()), ("b/y.txt".to_owned(), b"x\n".to_vec())]).await;
    let grep_says = text_of(GrepTool::new().call(&ctx, serde_json::json!({ "pattern": "x", "path": "a b" })).await).1;
    assert!(grep_says.contains(r#"grep takes an array for that: path: ["a","b"]"#), "{grep_says}");
    let both = grep(&ctx, serde_json::json!({ "pattern": "x", "path": ["a", "b"] })).await;
    assert!(both.contains("x.txt") && both.contains("y.txt"), "{both}");
    let list_says = text_of(ListTool::new().call(&ctx, serde_json::json!({ "path": "a, b" })).await).1;
    assert!(list_says.contains("list takes one path per call: list \"a\", \"b\""), "{list_says}");
    let listed = text_of(ListTool::new().call(&ctx, serde_json::json!({ "path": "a" })).await).1;
    assert!(listed.contains("x.txt"), "{listed}");
    let glob_says = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "*.txt", "path": "a b" })).await).1;
    assert!(glob_says.contains("glob takes one base path per call: use \"a\", \"b\""), "{glob_says}");
    let globbed = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "*.txt", "path": "a" })).await).1;
    assert!(globbed.contains("x.txt"), "{globbed}");
    // No part exists: no claim of a list.
    for text in [
        text_of(GrepTool::new().call(&ctx, serde_json::json!({ "pattern": "x", "path": "no such, thing" })).await).1,
        text_of(ListTool::new().call(&ctx, serde_json::json!({ "path": "no such, thing" })).await).1,
        text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "*", "path": "no such, thing" })).await).1,
    ] {
        assert!(!text.contains("several paths"), "{text}");
    }
}

/// One ignore rule for every grep mode: a gitignored file a glob names is listed by none of them.
#[tokio::test]
async fn a_gitignored_file_is_excluded_by_every_grep_mode() {
    let (dir, ctx) = tree(vec![
        (".gitignore".to_owned(), b"*.log\n".to_vec()),
        ("a.log".to_owned(), b"needle\n".to_vec()),
        ("b.txt".to_owned(), b"needle\n".to_vec()),
    ])
    .await;
    std::fs::create_dir_all(dir.path().join("ws/.git")).unwrap();
    for mode in ["files", "count", "content"] {
        let text = grep(&ctx, serde_json::json!({ "pattern": "needle", "mode": mode, "glob": "*.log" })).await;
        assert!(!text.contains("a.log"), "{mode}: {text}");
        let text = grep(&ctx, serde_json::json!({ "pattern": "needle", "mode": mode, "glob": "*.log", "include_noise": true })).await;
        assert!(text.contains("a.log"), "{mode} with include_noise: {text}");
    }
}

/// A footer names the limit that cut the page: the result limit when `limit` did, not a byte cap the output never neared.
#[tokio::test]
async fn a_footer_names_the_limit_that_cut_the_page() {
    let (_dir, ctx) = tree(vec![
        ("a/x.txt".to_owned(), rows('a', 6, 0)),
        ("b/x.txt".to_owned(), rows('b', 6, 0)),
    ])
    .await;
    let text = grep(&ctx, serde_json::json!({ "pattern": "needle", "path": ["a", "b"], "context": 0, "limit": 2, "section": 1 })).await;
    let footer = text.rsplit_once("\n[").map(|(_, f)| f).unwrap_or_default();
    assert!(footer.starts_with("result limit 2 reached"), "{text}");
    assert!(!text.contains("response limit"), "{text}");
}

/// A single-section answer cut to fit the byte cap names that cap, as a section of a compound one does.
#[tokio::test]
async fn a_single_section_cut_by_the_byte_cap_names_the_cap() {
    let (_dir, ctx) = tree(vec![("a/x.txt".to_owned(), rows('a', 80, 400))]).await;
    let text = grep(&ctx, serde_json::json!({ "pattern": "needle", "path": "a", "context": 0 })).await;
    assert!(text.contains("response limit"), "{text}");
}
