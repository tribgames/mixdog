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

fn write_marker(root: &Path, bytes: &[u8]) {
    mixdog_testkit::create_dir_all(root.join(".mixdog"));
    mixdog_testkit::write(root.join(".mixdog").join("project.id"), bytes);
}

async fn resolved(cwd: &Path) -> Exact {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let id = resolve_project_id(lane, cwd).await.expect("the marker walk runs");
    opt(id, string)
}

/// A case that writes `markerBytesHex` at a temp root and resolves from `cwdBelowMarkerRoot`.
async fn marker_case(index: usize, name: &str) {
    let golden = golden(SET);
    let case = case(&golden, index, name);
    let base = tempfile::tempdir().expect("temp dir");
    write_marker(base.path(), &hex(case.get("markerBytesHex").as_str()));
    let cwd = base.path().join(case.get("cwdBelowMarkerRoot").as_str());
    mixdog_testkit::create_dir_all(&cwd);
    same(name, case.get("result"), &resolved(&cwd).await);
}

#[test]
fn the_recording_has_eleven_cases() {
    assert_case_count(&golden(SET), 11);
}

#[tokio::test(flavor = "current_thread")]
async fn a_nul_filled_project_id_is_no_marker() {
    marker_case(0, "a NUL-filled project.id is no marker").await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_real_one_still_resolves() {
    marker_case(1, "a real one still resolves").await;
}

#[tokio::test(flavor = "current_thread")]
async fn common_is_the_common_scope() {
    marker_case(2, "common is the common scope").await;
}

#[tokio::test(flavor = "current_thread")]
async fn common_in_any_case() {
    marker_case(3, "COMMON in any case").await;
}

#[tokio::test(flavor = "current_thread")]
async fn blank_marker() {
    marker_case(4, "blank marker").await;
}

#[tokio::test(flavor = "current_thread")]
async fn empty_marker() {
    marker_case(5, "empty marker").await;
}

#[tokio::test(flavor = "current_thread")]
async fn crlf_line_end() {
    marker_case(6, "CRLF line end").await;
}

#[tokio::test(flavor = "current_thread")]
async fn nul_bytes_with_text_are_kept_as_read() {
    marker_case(7, "NUL bytes with text are kept as read").await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_sub_directory_resolves_through_the_ancestor_marker() {
    marker_case(8, "a sub directory resolves through the ancestor marker").await;
}

#[tokio::test(flavor = "current_thread")]
async fn an_inner_mixdog_without_project_id_does_not_mask_the_outer_marker() {
    let name = "an inner .mixdog without project.id does not mask the outer marker";
    let golden = golden(SET);
    let case = case(&golden, 9, name);
    assert_eq!(case.get("innerHasMarker"), &Exact::Bool(false));
    let base = tempfile::tempdir().expect("temp dir");
    // The outer marker text is the recorder's input (record-memory-project-id.mjs: projectWithId('outer-id\n')).
    write_marker(base.path(), b"outer-id\n");
    let inner = base.path().join("inner");
    mixdog_testkit::create_dir_all(inner.join(".mixdog"));
    same(name, case.get("result"), &resolved(&inner).await);
}

#[tokio::test(flavor = "current_thread")]
async fn no_marker_in_any_ancestor_of_the_temp_base() {
    let name = "no marker in any ancestor of the temp base";
    let golden = golden(SET);
    let case = case(&golden, 10, name);
    let base = tempfile::tempdir().expect("temp dir");
    let bare = base.path().join("bare");
    mixdog_testkit::create_dir_all(&bare);
    // The manifest's exclusion: the base must have no marker above it, as on the recording PC.
    let mut above = base.path().to_path_buf();
    while above.pop() {
        assert!(!above.join(".mixdog").join("project.id").exists(), "a marker above the temp base: {}", above.display());
    }
    same(name, case.get("result"), &resolved(&bare).await);
}
