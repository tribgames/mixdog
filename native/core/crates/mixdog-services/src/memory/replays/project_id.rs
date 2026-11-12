//! memory-project-id: `resolve_project_id` (memory/project.rs) on real directories holding the recorded
//! `.mixdog/project.id` bytes.

use mixdog_testkit::Exact;
use std::path::Path;

use super::{assert_case_count, case, golden, opt, same, string};
use crate::memory::project::resolve_project_id;

const SET: &str = "memory-project-id";

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex marker")).collect()
}

async fn resolved(cwd: &Path) -> Exact {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let id = resolve_project_id(lane, cwd).await.expect("the marker walk runs");
    opt(id, string)
}

/// Builds the case's recorded `layout` (directories, files with their bytes) under a fresh temp root, in order,
/// checks no marker lies above the root (as on the recording PC), resolves from the recorded `cwd`.
async fn tree_case(index: usize, name: &str) {
    let golden = golden(SET);
    let case = case(&golden, index, name);
    let base = tempfile::tempdir().expect("temp dir");
    let root = base.path().join("root");
    mixdog_testkit::create_dir_all(&root);
    for entry in case.get("layout").as_array() {
        match entry.try_get("dir") {
            Some(dir) => mixdog_testkit::create_dir_all(root.join(dir.as_str())),
            None => mixdog_testkit::write(root.join(entry.get("file").as_str()), hex(entry.get("bytesHex").as_str())),
        }
    }
    let mut above = root.clone();
    while above.pop() {
        assert!(!above.join(".mixdog").join("project.id").exists(), "a marker above the temp root: {}", above.display());
    }
    same(name, case.get("result"), &resolved(&root.join(case.get("cwd").as_str())).await);
}

#[test]
fn the_recording_has_eleven_cases() {
    assert_case_count(&golden(SET), 11);
}

#[tokio::test(flavor = "current_thread")]
async fn a_nul_filled_project_id_is_no_marker() {
    tree_case(0, "a NUL-filled project.id is no marker").await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_real_one_still_resolves() {
    tree_case(1, "a real one still resolves").await;
}

#[tokio::test(flavor = "current_thread")]
async fn common_is_the_common_scope() {
    tree_case(2, "common is the common scope").await;
}

#[tokio::test(flavor = "current_thread")]
async fn common_in_any_case() {
    tree_case(3, "COMMON in any case").await;
}

#[tokio::test(flavor = "current_thread")]
async fn blank_marker() {
    tree_case(4, "blank marker").await;
}

#[tokio::test(flavor = "current_thread")]
async fn empty_marker() {
    tree_case(5, "empty marker").await;
}

#[tokio::test(flavor = "current_thread")]
async fn crlf_line_end() {
    tree_case(6, "CRLF line end").await;
}

#[tokio::test(flavor = "current_thread")]
async fn nul_bytes_with_text_are_kept_as_read() {
    tree_case(7, "NUL bytes with text are kept as read").await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_sub_directory_resolves_through_the_ancestor_marker() {
    tree_case(8, "a sub directory resolves through the ancestor marker").await;
}

#[tokio::test(flavor = "current_thread")]
async fn an_inner_mixdog_without_project_id_does_not_mask_the_outer_marker() {
    tree_case(9, "an inner .mixdog without project.id does not mask the outer marker").await;
}

#[tokio::test(flavor = "current_thread")]
async fn no_marker_in_any_ancestor_of_the_temp_base() {
    tree_case(10, "no marker in any ancestor of the temp base").await;
}