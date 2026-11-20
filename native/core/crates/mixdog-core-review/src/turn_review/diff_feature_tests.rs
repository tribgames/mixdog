//! The diffs a review shows: line hunks and their exactness under a spent budget, patch headers, the bounds on a patch, the diff of
//! a tool call's changes, the registry of card diffs, and Node-style path handling.

use mixdog_core_api::turn_review::ReviewContent;
use serde_json::{Value, json};

use super::call_diff::{CardDiffs, TrackedChange, measure_call_changes};
use super::line_diff::{Hunk, LineDiffBudget, LineDiffer, unified_hunks_body};
use super::nodepath::{self, Style};
use super::review_diff;

fn hunk_json(hunk: &Hunk) -> Value {
    json!({ "oldStart": hunk.old_start, "oldLines": hunk.old_lines, "newStart": hunk.new_start, "newLines": hunk.new_lines, "lines": hunk.lines })
}

fn diff(old: &str, new: &str) -> (Vec<Value>, bool, String) {
    let mut budget = LineDiffBudget::new(10_000_000.0);
    let set = LineDiffer::new().hunks(old, new, &mut budget, [None, None]);
    let body = unified_hunks_body("a/f", "b/f", &set.hunks);
    (set.hunks.iter().map(hunk_json).collect(), set.exact, body)
}

#[test]
fn a_changed_line_is_one_hunk_with_its_context() {
    let (hunks, exact, body) = diff("a\nb\nc\n", "a\nB\nc\n");
    assert_eq!(hunks, [json!({ "oldStart": 1, "oldLines": 3, "newStart": 1, "newLines": 3, "lines": [" a", "-b", "+B", " c"] })]);
    assert!(exact);
    assert_eq!(body, "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
}

#[test]
fn an_insertion_a_deletion_a_creation_and_an_emptying_are_hunks_of_their_own() {
    assert_eq!(diff("b\nc\n", "a\nb\nc\n").2, "--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n+a\n b\n c\n");
    assert_eq!(diff("a\nb\nc\n", "a\nb\n").2, "--- a/f\n+++ b/f\n@@ -1,3 +1,2 @@\n a\n b\n-c\n");
    assert_eq!(diff("", "one\ntwo\n").2, "--- a/f\n+++ b/f\n@@ -0,0 +1,2 @@\n+one\n+two\n");
    let (hunks, _, _) = diff("one\ntwo\n", "");
    assert_eq!(hunks[0]["oldLines"], 2);
    assert_eq!(hunks[0]["newLines"], 0);
    assert_eq!(hunks[0]["lines"], json!(["-one", "-two"]));
}

#[test]
fn identical_texts_have_no_hunks() {
    let (hunks, exact, _) = diff("same\n", "same\n");
    assert!(hunks.is_empty() && exact);
}

#[test]
fn a_spent_budget_gives_the_whole_replacement_hunk_and_says_it_is_not_exact() {
    let differ = LineDiffer::new();
    let mut budget = LineDiffBudget::new(0.0);
    let set = differ.hunks("a\nb\nc\nd\ne\nf\ng\n", "a\nb\nc\nX\ne\nf\ng\n", &mut budget, [None, None]);
    assert!(!set.exact);
    assert_eq!(
        set.hunks.iter().map(hunk_json).collect::<Vec<_>>(),
        [json!({ "oldStart": 1, "oldLines": 7, "newStart": 1, "newLines": 7, "lines": [" a", " b", " c", "-d", "+X", " e", " f", " g"] })]
    );
    let created = differ.hunks("", "new\n", &mut budget, [None, None]);
    assert_eq!(
        (created.exact, created.hunks.iter().map(hunk_json).collect::<Vec<_>>()),
        (false, vec![json!({ "oldStart": 1, "oldLines": 0, "newStart": 1, "newLines": 1, "lines": ["+new"] })])
    );
}

#[test]
fn a_patch_header_quotes_a_name_git_would_quote_and_leaves_a_plain_one() {
    let mut budget = LineDiffBudget::new(10_000_000.0);
    let hunks = LineDiffer::new().hunks("a\nb\n", "a\nc\n", &mut budget, [None, None]).hunks.clone();
    let tail = "@@ -1,2 +1,2 @@\n a\n-b\n+c\n";
    for (old, new, head) in [
        ("/dev/null", "b/new file.txt", "--- /dev/null\n+++ b/new file.txt\n"),
        ("a/café.txt", "b/café.txt", "--- \"a/caf\\303\\251.txt\"\n+++ \"b/caf\\303\\251.txt\"\n"),
        ("a/with \"quote\".txt", "b/with \"quote\".txt", "--- \"a/with \\\"quote\\\".txt\"\n+++ \"b/with \\\"quote\\\".txt\"\n"),
        ("a/back\\slash.txt", "b/back\\slash.txt", "--- \"a/back\\\\slash.txt\"\n+++ \"b/back\\\\slash.txt\"\n"),
        ("a/tab\tname.txt", "b/tab\tname.txt", "--- \"a/tab\\tname.txt\"\n+++ \"b/tab\\tname.txt\"\n"),
        (
            "a/日本語/emoji😀.txt",
            "b/日本語/emoji😀.txt",
            "--- \"a/\\346\\227\\245\\346\\234\\254\\350\\252\\236/emoji\\360\\237\\230\\200.txt\"\n+++ \"b/\\346\\227\\245\\346\\234\\254\\350\\252\\236/emoji\\360\\237\\230\\200.txt\"\n",
        ),
    ] {
        assert_eq!(unified_hunks_body(old, new, &hunks), format!("{head}{tail}"), "{old}");
    }
    assert_eq!(unified_hunks_body("/dev/null", "b/empty.txt", &Vec::new()), "--- /dev/null\n+++ b/empty.txt\n", "no hunks, only the header");
}

#[test]
fn a_patch_that_fits_is_kept_and_one_that_does_not_is_cut_at_a_section_with_a_marker() {
    let small = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n";
    assert_eq!(review_diff::bound_review_patch(small, 10_000), (small.to_owned(), false));
    let marked = "diff --git a/x b/x\n… [diff truncated for display]\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1,1 +1,1 @@\nz\n";
    assert_eq!(review_diff::bound_review_patch(marked, 10_000), (marked.to_owned(), true), "an already truncated patch stays so");
    let wide = format!("diff --git a/é.txt b/é.txt\n--- a/é.txt\n+++ b/é.txt\n@@ -1,1 +1,1 @@\n-{}\n+x\n", "日".repeat(150));
    assert_eq!(
        review_diff::bound_review_patch(&wide, 120),
        ("diff --git a/é.txt b/é.txt\n--- a/é.txt\n+++ b/é.txt\n… [diff truncated for display]\n".to_owned(), true),
        "the bound counts UTF-16 units and keeps the file's headers"
    );
}

#[test]
fn the_patch_budget_admits_what_fits_in_what_remains() {
    let mut budget = review_diff::ReviewPatchBudget::new(2_000_000);
    for (bytes, admitted, remaining) in
        [(1_000_000, true, 1_000_000), (1_000_001, false, 1_000_000), (900_000, true, 100_000), (1_000_000, false, 100_000), (100_000, true, 0)]
    {
        assert_eq!(budget.admit(bytes), admitted, "{bytes}");
        assert_eq!(budget.remaining(), remaining);
    }
}

#[test]
fn a_file_patch_is_sent_whole_or_omitted_as_too_large() {
    assert_eq!(Value::Object(review_diff::file_patch_reply("p", "text", 8_388_608)), json!({ "supported": true, "path": "p", "patch": "text" }));
    assert_eq!(Value::Object(review_diff::file_patch_reply("p", "", 8_388_608)), json!({ "supported": true, "path": "p", "patch": "" }));
    assert_eq!(
        Value::Object(review_diff::file_patch_reply("p", &"x".repeat(40), 32)),
        json!({ "supported": true, "path": "p", "patch": "", "patchOmitted": true, "reason": "too_large" })
    );
}

fn content(text: Option<&str>) -> ReviewContent {
    text.map_or(ReviewContent::Absent, |text| ReviewContent::bytes(text.as_bytes().to_vec()))
}

fn change(display: &str, before: ReviewContent, after: ReviewContent) -> TrackedChange {
    TrackedChange {
        path: format!("/virtual/{display}"),
        display_path: display.to_owned(),
        new_path: None,
        new_display_path: None,
        before,
        after,
        additions: None,
        deletions: None,
    }
}

fn measured(changes: Vec<TrackedChange>) -> (String, Vec<(u64, u64)>) {
    let mut budget = LineDiffBudget::new(10_000_000.0);
    let (diff, counted) = measure_call_changes(&LineDiffer::new(), changes, &mut budget);
    (diff, counted.iter().map(|c| (c.additions.unwrap_or(0), c.deletions.unwrap_or(0))).collect())
}

#[test]
fn a_calls_changes_become_one_git_style_diff_with_their_line_counts() {
    assert_eq!(
        measured(vec![change("src/a.txt", content(Some("a\nb\nc\n")), content(Some("a\nB\nc\n")))]),
        ("diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n".to_owned(), vec![(1, 1)])
    );
    assert_eq!(
        measured(vec![change("new.txt", content(None), content(Some("hi\n")))]),
        ("diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hi\n".to_owned(), vec![(1, 0)])
    );
    assert_eq!(
        measured(vec![change("old.txt", content(Some("bye\n")), content(None))]),
        ("diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n".to_owned(), vec![(0, 1)])
    );
    assert_eq!(
        measured(vec![change("empty.txt", content(None), content(Some("")))]),
        ("diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n".to_owned(), vec![(0, 0)])
    );
    assert_eq!(
        measured(vec![change("same.txt", content(Some("x\n")), content(Some("x\n")))]),
        (String::new(), vec![(0, 0)]),
        "an unchanged file shows nothing"
    );
}

#[test]
fn a_rename_shows_its_similarity_and_a_binary_or_omitted_file_shows_no_lines() {
    let mut rename = change("a.txt", content(Some("x\n")), content(Some("x\n")));
    rename.new_path = Some("/virtual/b.txt".into());
    rename.new_display_path = Some("b.txt".into());
    assert_eq!(measured(vec![rename]).0, "diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n");
    let binary = measured(vec![change("bin.dat", ReviewContent::bytes(vec![1, 0, 2]), ReviewContent::bytes(vec![1, 0, 3]))]);
    assert_eq!(
        (binary.0.as_str(), binary.1.as_slice()),
        ("diff --git a/bin.dat b/bin.dat\nBinary files a/bin.dat and b/bin.dat differ\n", [(0, 0)].as_slice())
    );
    let invalid = measured(vec![change("bad.txt", content(Some("ok\n")), ReviewContent::bytes(vec![0xff, 0xfe, 0x41]))]);
    assert_eq!(invalid.0, "diff --git a/bad.txt b/bad.txt\nBinary files a/bad.txt and b/bad.txt differ\n", "invalid UTF-8 is binary");
    let omitted = measured(vec![change("big.bin", ReviewContent::Omitted { size: 70_000_000, reason: Some("oversized".into()) }, content(Some("small\n")))]);
    assert_eq!(omitted.0, "diff --git a/big.bin b/big.bin\nBinary files a/big.bin and b/big.bin differ\n");
}

#[test]
fn display_names_are_slashed_trimmed_defaulted_and_quoted_by_the_header_rule() {
    assert_eq!(
        measured(vec![change("", content(None), content(Some("x\n")))]).0,
        "diff --git a/unknown file b/unknown file\nnew file mode 100644\n--- /dev/null\n+++ b/unknown file\n@@ -0,0 +1,1 @@\n+x\n"
    );
    assert_eq!(
        measured(vec![change("  dir\\sub\\f.txt ", content(Some("a\n")), content(Some("b\n")))]).0,
        "diff --git a/dir/sub/f.txt b/dir/sub/f.txt\n--- a/dir/sub/f.txt\n+++ b/dir/sub/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n"
    );
    assert_eq!(
        measured(vec![change("w.txt", content(Some("a\r\nb")), content(Some("a\r\nc")))]).0,
        "diff --git a/w.txt b/w.txt\n--- a/w.txt\n+++ b/w.txt\n@@ -1,2 +1,2 @@\n a\r\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n"
    );
    assert_eq!(
        measured(vec![change("café/日本.txt", content(Some("a\n")), content(Some("b\n")))]).0,
        "diff --git a/café/日本.txt b/café/日本.txt\n--- \"a/caf\\303\\251/\\346\\227\\245\\346\\234\\254.txt\"\n+++ \"b/caf\\303\\251/\\346\\227\\245\\346\\234\\254.txt\"\n@@ -1,1 +1,1 @@\n-a\n+b\n"
    );
}

#[test]
fn two_files_in_one_call_are_two_sections_with_their_own_counts() {
    let (diff, counts) =
        measured(vec![change("one.txt", content(Some("1\n")), content(Some("2\n"))), change("two.txt", content(None), content(Some("new\n")))]);
    assert_eq!(
        diff,
        "diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1,1 +1,1 @@\n-1\n+2\ndiff --git a/two.txt b/two.txt\nnew file mode 100644\n--- /dev/null\n+++ b/two.txt\n@@ -0,0 +1,1 @@\n+new\n"
    );
    assert_eq!(counts, [(1, 1), (1, 0)]);
}

#[test]
fn the_card_registry_keeps_the_newest_sixty_four_and_hands_each_diff_out_once() {
    let cards = CardDiffs::default();
    for i in 0..70 {
        cards.register(&format!("c{i}"), "d");
    }
    let taken: Vec<bool> = ["c0", "c5", "c6", "c69", "c69", "nope", ""].iter().map(|id| cards.take(id).is_some()).collect();
    assert_eq!(taken, [false, false, true, true, false, false, false], "the six oldest were dropped and a taken diff is gone");
    for i in 0..64 {
        cards.register(&format!("r{i}"), "x");
    }
    cards.register("r10", "again");
    cards.register("extra", "e");
    let taken: Vec<bool> = ["r0", "r1", "r10", "extra"].iter().map(|id| cards.take(id).is_some()).collect();
    assert_eq!(taken, [false, true, true, true], "registering past the bound drops the oldest; a re-registered id stays");
    assert_eq!(cards.take("r10"), None);
}

#[test]
fn node_path_functions_resolve_and_relate_paths_by_platform_rules() {
    for (style, base, target, want) in [
        (Style::Posix, "/a/b", "/a/b/c/d", "c/d"),
        (Style::Posix, "/a/b", "/a/x", "../x"),
        (Style::Posix, "/a/b", "/", "../.."),
        (Style::Posix, "/a/b", "/a/b/../c", "../c"),
        (Style::Posix, "/a/b", "/a/./b/", ""),
        (Style::Posix, "/a/b", "/a b/c", "../../a b/c"),
        (Style::Posix, "/a/b", "/A/b", "../../A/b"),
        (Style::Posix, "/", "/a/b", "a/b"),
        (Style::Win32, "C:\\a\\b", "C:\\a\\b\\c\\d", "c\\d"),
        (Style::Win32, "C:\\a\\b", "c:\\A\\B", ""),
        (Style::Win32, "C:\\a\\b", "C:\\a\\x", "..\\x"),
        (Style::Win32, "C:\\a\\b", "D:\\a\\b", "D:\\a\\b"),
        (Style::Win32, "C:\\a\\b", "C:\\", "..\\.."),
        (Style::Win32, "C:\\a\\b", "C:/a/b/c", "c"),
        (Style::Win32, "C:\\a\\b", "\\\\srv\\share\\dir", "\\\\srv\\share\\dir"),
    ] {
        assert_eq!(nodepath::relative(style, base, target), want, "{base} -> {target}");
    }
    assert!(nodepath::is_absolute(Style::Posix, "/a/b") && nodepath::is_absolute(Style::Win32, "c:\\A\\B"));
    assert_eq!(nodepath::resolve(Style::Posix, &["/a/b"]), "/a/b");
    assert_eq!(nodepath::resolve(Style::Win32, &["c:\\A\\B"]), "c:\\A\\B");
}
