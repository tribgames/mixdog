//! The rules of the turn review's pure parts: line diffs and their patch text, the bounds of a review reply, the card diff of one
//! tool call and its registry, and the path rules the review compares paths by.

use mixdog_core_api::turn_review::ReviewContent;

use super::call_diff::CardDiffs;
use super::call_diff::TrackedChange;
use super::call_diff::measure_call_changes;
use super::call_diff::patch_header_path_for_resolved;
use super::line_diff::LineDiffBudget;
use super::line_diff::LineDiffer;
use super::line_diff::unified_hunks_body;
use super::nodepath;
use super::nodepath::Style;
use super::review_diff;

fn hunks(old: &str, new: &str, budget_ms: f64) -> (Vec<(usize, usize, usize, usize, Vec<String>)>, bool) {
    let mut budget = LineDiffBudget::new(budget_ms);
    let set = LineDiffer::new().hunks(old, new, &mut budget, [None, None]);
    (set.hunks.iter().map(|h| (h.old_start, h.old_lines, h.new_start, h.new_lines, h.lines.clone())).collect(), set.exact)
}

fn lines(items: &[&str]) -> Vec<String> {
    items.iter().map(|line| (*line).to_owned()).collect()
}

#[test]
fn a_changed_line_is_one_hunk_with_three_lines_of_context() {
    let (set, exact) = hunks("a\nb\nc\nd\ne\nf\ng\nh\ni\n", "a\nb\nc\nd\nE\nf\ng\nh\ni\n", 10_000.0);
    assert!(exact);
    assert_eq!(set, vec![(2, 7, 2, 7, lines(&[" b", " c", " d", "-e", "+E", " f", " g", " h"]))]);
}

#[test]
fn identical_texts_have_no_hunks_and_far_apart_changes_are_separate_hunks() {
    assert_eq!(hunks("a\nb\n", "a\nb\n", 10_000.0), (Vec::new(), true));
    let old: String = (0..20).map(|n| format!("l{n}\n")).collect();
    let new = old.replacen("l1\n", "L1\n", 1).replacen("l18\n", "L18\n", 1);
    let (set, _) = hunks(&old, &new, 10_000.0);
    assert_eq!(set.len(), 2, "{set:?}");
    assert_eq!((set[0].0, set[1].0), (1, 16));
}

#[test]
fn a_missing_final_newline_is_marked() {
    let (set, _) = hunks("a\nb", "a\nb\n", 10_000.0);
    assert_eq!(set, vec![(1, 2, 1, 2, lines(&[" a", "-b", "\\ No newline at end of file", "+b"]))]);
}

#[test]
fn a_patch_body_has_its_headers_the_hunk_ranges_and_exactly_one_final_newline() {
    let mut budget = LineDiffBudget::new(10_000.0);
    let set = LineDiffer::new().hunks("a\nb\nc\n", "a\nB\nc\n", &mut budget, [None, None]);
    assert_eq!(unified_hunks_body("a/f.txt", "b/f.txt", &set.hunks), "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    assert_eq!(unified_hunks_body("a/f.txt", "b/f.txt", &[]), "--- a/f.txt\n+++ b/f.txt\n");
}

#[test]
fn a_non_ascii_file_name_is_quoted_in_the_header() {
    let mut budget = LineDiffBudget::new(10_000.0);
    let set = LineDiffer::new().hunks("a\n", "b\n", &mut budget, [None, None]);
    let body = unified_hunks_body("a/ü.txt", "b/ü.txt", &set.hunks);
    assert!(body.starts_with("--- \"a/\\303\\274.txt\"\n+++ \"b/\\303\\274.txt\"\n"), "{body}");
}

#[test]
fn a_spent_budget_gives_one_replacement_hunk_between_the_common_ends() {
    let (set, exact) = hunks("a\nb\nc\n", "c\nb\na\n", 0.0);
    assert!(!exact, "the diff did not finish in its budget");
    assert_eq!(set, vec![(1, 3, 1, 3, lines(&["-a", "-b", "-c", "+c", "+b", "+a"]))]);
    let (same_ends, _) = hunks("x\nold\ny\n", "x\nnew\ny\n", 0.0);
    assert_eq!(same_ends, vec![(1, 3, 1, 3, lines(&[" x", "-old", "+new", " y"]))], "the common prefix and suffix stay context");
}

#[test]
fn a_patch_inside_its_cap_is_kept_and_over_it_only_hunk_bodies_are_cut_never_the_headers() {
    let small = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    assert_eq!(review_diff::bound_review_patch(small, 1000), (small.to_owned(), false));

    let big = format!("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n{}\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n", "+".repeat(500));
    let (bounded, truncated) = review_diff::bound_review_patch(&big, 400);
    assert!(truncated);
    assert!(bounded.contains("diff --git a/x b/x\n--- a/x\n+++ b/x\n… [diff truncated for display]\n"), "{bounded}");
    assert!(bounded.contains("diff --git a/y b/y"), "every file stays listed");
    assert!(review_diff::review_section_truncated(&bounded));
}

#[test]
fn a_reply_takes_patch_text_within_the_per_file_and_total_caps() {
    let mut budget = review_diff::ReviewPatchBudget::new(2_000_000);
    assert!(budget.admit(1_000_000));
    assert!(!budget.admit(1_024 * 1_024 + 1), "past the per-file cap");
    assert!(budget.admit(1_000_000));
    assert!(!budget.admit(1), "the total is spent");
}

#[test]
fn a_file_patch_read_returns_the_patch_or_says_it_is_too_large() {
    let small = review_diff::file_patch_reply("a.txt", "PATCH", 10);
    assert_eq!(serde_json::Value::Object(small), serde_json::json!({ "supported": true, "path": "a.txt", "patch": "PATCH" }));
    let large = review_diff::file_patch_reply("a.txt", "PATCH-TOO-LONG", 10);
    assert_eq!(serde_json::Value::Object(large), serde_json::json!({ "supported": true, "path": "a.txt", "patch": "", "patchOmitted": true, "reason": "too_large" }));
}

fn change(name: &str, before: ReviewContent, after: ReviewContent) -> TrackedChange {
    TrackedChange {
        path: format!("/virtual/{name}"),
        display_path: name.to_owned(),
        new_path: None,
        new_display_path: None,
        before,
        after,
        additions: None,
        deletions: None,
    }
}

fn text(value: &str) -> ReviewContent {
    ReviewContent::bytes(value.as_bytes().to_vec())
}

fn measure(changes: Vec<TrackedChange>) -> (String, Vec<(u64, u64)>) {
    let (diff, measured) = measure_call_changes(&LineDiffer::new(), changes, &mut LineDiffBudget::new(10_000.0));
    (diff, measured.iter().map(|c| (c.additions.unwrap(), c.deletions.unwrap())).collect())
}

#[test]
fn a_call_diff_names_the_files_and_counts_the_lines_each_call_added_and_removed() {
    let (diff, counts) = measure(vec![change("a.txt", text("one\ntwo\n"), text("one\n2\nthree\n"))]);
    assert_eq!(diff, "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n one\n-two\n+2\n+three\n");
    assert_eq!(counts, [(2, 1)]);
}

#[test]
fn a_created_or_deleted_file_has_a_mode_line_and_a_dev_null_side() {
    let (diff, counts) = measure(vec![change("n.txt", ReviewContent::Absent, text("x\n"))]);
    assert_eq!(diff, "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+x\n");
    assert_eq!(counts, [(1, 0)]);
    let (diff, counts) = measure(vec![change("d.txt", text("x\n"), ReviewContent::Absent)]);
    assert_eq!(diff, "diff --git a/d.txt b/d.txt\ndeleted file mode 100644\n--- a/d.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n");
    assert_eq!(counts, [(0, 1)]);
    let (diff, _) = measure(vec![change("empty", ReviewContent::Absent, text(""))]);
    assert_eq!(diff, "diff --git a/empty b/empty\nnew file mode 100644\n", "an empty file created still changed");
}

#[test]
fn an_unchanged_file_has_no_diff_a_rename_names_both_and_binary_or_omitted_content_is_not_diffed() {
    assert_eq!(measure(vec![change("same.txt", text("x\n"), text("x\n"))]).0, "");
    let mut renamed = change("old.txt", text("x\n"), text("x\n"));
    renamed.new_display_path = Some("new.txt".into());
    assert_eq!(measure(vec![renamed]).0, "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n");
    let binary = ReviewContent::bytes(vec![0xff, 0xfe, 0x00, 0x01]);
    assert_eq!(measure(vec![change("b.bin", binary, text("x\n"))]).0, "diff --git a/b.bin b/b.bin\nBinary files a/b.bin and b/b.bin differ\n");
    let omitted = ReviewContent::Omitted { size: 9_999_999, reason: None };
    assert!(measure(vec![change("big.txt", omitted, text("x\n"))]).0.contains("Binary files"));
}

#[test]
fn a_header_path_is_relative_to_the_base_when_inside_it_and_as_given_otherwise() {
    assert_eq!(patch_header_path_for_resolved("/ws", "/ws/a/b.txt"), "a/b.txt");
    assert_eq!(patch_header_path_for_resolved("/ws", "/elsewhere/c.txt"), "/elsewhere/c.txt");
    assert_eq!(patch_header_path_for_resolved("/ws", "/ws"), "/ws", "the base itself is not inside it");
}

#[test]
fn the_card_registry_keeps_the_newest_sixty_four_and_gives_each_diff_once() {
    let cards = CardDiffs::default();
    for n in 0..70 {
        cards.register(&format!("c{n}"), "d");
    }
    assert_eq!(cards.take("c0"), None, "the oldest are out");
    assert_eq!(cards.take("c5"), None);
    assert_eq!(cards.take("c6"), Some("d".to_owned()));
    assert_eq!(cards.take("c6"), None, "taken once");
    assert_eq!(cards.take("c69"), Some("d".to_owned()));
    assert_eq!(cards.take("nope"), None);
    assert_eq!(cards.take(""), None);
    cards.register("", "ignored");
    assert_eq!(cards.take(""), None);
}

#[test]
fn a_card_diff_over_its_cap_is_cut_for_display() {
    let cards = CardDiffs::default();
    let huge = format!("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n{}\n", "+".repeat(70_000));
    cards.register("big", &huge);
    let taken = cards.take("big").unwrap();
    assert!(taken.len() < 1000 && review_diff::review_section_truncated(&taken), "{}", taken.len());
}

#[test]
fn paths_resolve_relate_and_classify_by_the_flavour_of_their_platform() {
    assert_eq!(nodepath::resolve(Style::Posix, &["/a/b", "../c"]), "/a/c");
    assert_eq!(nodepath::resolve(Style::Posix, &["/a", "/b", "c"]), "/b/c", "an absolute part restarts");
    assert_eq!(nodepath::relative(Style::Posix, "/a/b/c", "/a/d"), "../../d");
    assert!(nodepath::is_absolute(Style::Posix, "/x") && !nodepath::is_absolute(Style::Posix, "x"));

    assert_eq!(nodepath::resolve(Style::Win32, &["C:\\a", "..\\b"]), "C:\\b");
    assert_eq!(nodepath::relative(Style::Win32, "C:\\a\\b", "C:\\a\\c"), "..\\c");
    assert_eq!(nodepath::relative(Style::Win32, "C:\\A", "c:\\a\\b"), "b", "drive and folder case do not matter on Windows");
    assert!(nodepath::is_absolute(Style::Win32, "C:\\x") && nodepath::is_absolute(Style::Win32, "\\\\server\\share\\x"));
    assert!(!nodepath::is_absolute(Style::Win32, "C:x") && !nodepath::is_absolute(Style::Win32, "x\\y"));
}
