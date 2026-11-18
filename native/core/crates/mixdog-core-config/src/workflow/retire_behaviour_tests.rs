//! The boot-time retirement of untouched copies of shipped definitions: a copy equal to the shipped version (or, once per
//! history stamp, to a past one) moves into a timestamped backup folder; a copy the user changed never moves.

use std::path::Path;

use mixdog_rt::CancellationToken;

use super::WorkflowPaths;
use super::retire::HISTORY_MARKER_FILE;
use super::retire::retire_seeded_copies;

const NOW: &str = "2026-01-01T00:00:00.000Z";
const BACKUP: &str = "backups/defaults-separation-2026-01-01T00-00-00-000Z";

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

async fn pass(root: &Path, data: &Path) {
    let paths = WorkflowPaths { root: root.to_owned(), data: data.to_owned() };
    mixdog_core_base::support::on_lane(mixdog_rt::testing::tokens().maintenance_io, &CancellationToken::new(), move |lane| {
        retire_seeded_copies(lane, &paths, &|| NOW.to_owned())
    })
    .await
    .expect("lane job")
    .expect("the pass never throws here");
}

fn sha32(text: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(text.as_bytes()).iter().take(16).map(|byte| format!("{byte:02x}")).collect()
}

#[tokio::test]
async fn a_copy_equal_to_the_shipped_style_moves_into_a_backup_and_an_edited_one_stays() {
    let dir = tempfile::tempdir().unwrap();
    let (root, data) = (dir.path().join("package"), dir.path().join("data"));
    write(&root.join("output-styles/plain.md"), "shipped plain");
    write(&root.join("output-styles/edited.md"), "shipped edited");
    write(&data.join("output-styles/plain.md"), "shipped plain");
    write(&data.join("output-styles/edited.md"), "the user's own words");
    write(&data.join("output-styles/mine.md"), "not shipped at all");

    pass(&root, &data).await;

    assert!(!data.join("output-styles/plain.md").exists());
    assert_eq!(std::fs::read_to_string(data.join(BACKUP).join("output-styles/plain.md")).unwrap(), "shipped plain");
    assert_eq!(std::fs::read_to_string(data.join("output-styles/edited.md")).unwrap(), "the user's own words");
    assert_eq!(std::fs::read_to_string(data.join("output-styles/mine.md")).unwrap(), "not shipped at all");
}

#[tokio::test]
async fn trailing_whitespace_and_line_ending_differences_do_not_make_a_copy_a_change() {
    let dir = tempfile::tempdir().unwrap();
    let (root, data) = (dir.path().join("package"), dir.path().join("data"));
    write(&root.join("output-styles/plain.md"), "line one\nline two");
    write(&data.join("output-styles/plain.md"), "line one  \r\nline two\r\n");
    pass(&root, &data).await;
    assert!(!data.join("output-styles/plain.md").exists());
}

#[tokio::test]
async fn a_past_shipped_version_is_retired_once_per_history_stamp() {
    let dir = tempfile::tempdir().unwrap();
    let (root, data) = (dir.path().join("package"), dir.path().join("data"));
    write(&root.join("output-styles/plain.md"), "current");
    write(&root.join("defaults/shipped-history.json"), &format!(r#"{{"outputStyles":{{"plain.md":["{}"]}}}}"#, sha32("old version")));
    write(&data.join("output-styles/plain.md"), "old version");

    pass(&root, &data).await;
    assert!(!data.join("output-styles/plain.md").exists(), "a copy of a past version goes on the first pass");
    assert!(data.join(HISTORY_MARKER_FILE).exists(), "the stamp is recorded when nothing failed");

    write(&data.join("output-styles/plain.md"), "old version");
    pass(&root, &data).await;
    assert_eq!(std::fs::read_to_string(data.join("output-styles/plain.md")).unwrap(), "old version", "the history is not compared again");
}

#[tokio::test]
async fn an_unchanged_workflow_pack_moves_but_one_with_an_added_file_is_the_users() {
    let dir = tempfile::tempdir().unwrap();
    let (root, data) = (dir.path().join("package"), dir.path().join("data"));
    let pack = "---\nname: flow\ndescription: a flow\n---\nsteps";
    write(&root.join("workflows/flow/WORKFLOW.md"), pack);
    write(&root.join("workflows/mine/WORKFLOW.md"), pack);
    write(&data.join("workflows/flow/WORKFLOW.md"), pack);
    write(&data.join("workflows/mine/WORKFLOW.md"), pack);
    write(&data.join("workflows/mine/notes.md"), "my reference");

    pass(&root, &data).await;

    assert!(!data.join("workflows/flow").exists());
    assert!(data.join(BACKUP).join("workflows/flow/WORKFLOW.md").exists());
    assert!(data.join("workflows/mine/notes.md").exists(), "a pack with a file of its own stays whole");
}

#[tokio::test]
async fn a_backup_folder_of_the_same_name_is_never_reused() {
    let dir = tempfile::tempdir().unwrap();
    let (root, data) = (dir.path().join("package"), dir.path().join("data"));
    write(&root.join("output-styles/a.md"), "shipped a");
    write(&data.join("output-styles/a.md"), "shipped a");
    pass(&root, &data).await;
    write(&data.join("output-styles/a.md"), "shipped a");
    pass(&root, &data).await;
    assert!(data.join(BACKUP).join("output-styles/a.md").exists());
    assert!(data.join(format!("{BACKUP}-2")).join("output-styles/a.md").exists());
}
