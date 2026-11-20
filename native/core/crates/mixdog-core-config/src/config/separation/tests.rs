//! Claiming a backup folder: a taken name and two racing claims get different folders.

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;

use super::*;
use crate::config::ConfigLanes;

pub(in crate::config) async fn open(dir: &Path) -> Config {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.expect("opens");
    config
}

/// File work of a test runs as a job on the write lane, as the pass's own does.
pub(in crate::config) async fn lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    super::super::on_lane(mixdog_rt::testing::tokens().durability_io, job).await.expect("lane job")
}

/// `path` written with `text`, its folder made first.
pub(in crate::config) async fn put(path: std::path::PathBuf, text: String) {
    lane(move |lane| {
        mixdog_statefile::create_dir_all(lane, path.parent().expect("parent")).expect("folder");
        mixdog_statefile::write_file_stepped(lane, &path, text.as_bytes(), &mixdog_statefile::Opts::default()).expect("file");
    })
    .await;
}

/// Two claims of the same name are given different folders (`mkdirSync` throwing `EEXIST` moves on to the next
/// name): a name already taken, and two claims racing for one name.
#[tokio::test]
async fn claims_that_collide_get_different_folders() {
    let dir = tempfile::tempdir().expect("dir");
    let parent = dir.path().to_path_buf();
    let taken = parent.join("defaults-separation-x");
    lane({
        let taken = taken.clone();
        move |lane| mixdog_statefile::create_dir_all(lane, &taken).expect("taken")
    })
    .await;
    let claimed = lane({
        let parent = parent.clone();
        move |lane| claim_dir(lane, &parent, "defaults-separation-x").expect("claim")
    })
    .await;
    assert_eq!(claimed, parent.join("defaults-separation-x-1"), "a taken name moves on to the next");

    let claim = |parent: std::path::PathBuf| lane(move |lane| claim_dir(lane, &parent, "defaults-separation-y").expect("claim"));
    let (first, second) = tokio::join!(claim(parent.clone()), claim(parent.clone()));
    assert_ne!(first, second, "two claims for one name never share a folder");
    let mut names: Vec<_> = [first, second].iter().map(|dir| dir.file_name().expect("name").to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["defaults-separation-y", "defaults-separation-y-1"]);
}
