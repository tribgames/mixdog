//! Archive of a full captured stream (`persistToolResultArtifactSync`): a content-addressed file
//! `<data>/tool-results/<session>/<sha256>.txt`, so compacted output can be read back whole.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "lane job bodies are the sanctioned home of blocking file I/O (clippy.toml)")]

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use sha2::Digest;
use sha2::Sha256;
use tokio_util::sync::CancellationToken;

use super::compact::Recovery;
use super::jobs::shown_path;

/// `safeSessionSegment`: every character outside `[A-Za-z0-9_-]` becomes `_`, at most 200.
fn safe_segment(session: &str) -> String {
    let mapped: String = session.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    let cut: String = mapped.encode_utf16().take(200).map(|u| char::from_u32(u32::from(u)).unwrap_or('_')).collect();
    if cut.is_empty() { "_invalid".to_owned() } else { cut }
}

/// What sits at an artifact's content-addressed path (`existingArtifactStateSync`): the verified bytes, a file a crash
/// left without data (empty or NUL only, replaced whole), or anything else (different bytes, a link, a directory),
/// which is evidence that is never touched.
enum Existing {
    Absent,
    Intact,
    Damaged,
    Foreign,
}

fn existing(path: &Path, content: &str) -> std::io::Result<Existing> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Existing::Absent),
        Err(e) => return Err(e),
    };
    if !meta.is_file() {
        return Ok(Existing::Foreign);
    }
    if meta.len() != content.len() as u64 {
        return Ok(if meta.len() == 0 { Existing::Damaged } else { Existing::Foreign });
    }
    let bytes = std::fs::read(path)?;
    Ok(if bytes == content.as_bytes() {
        Existing::Intact
    } else if bytes.iter().all(|b| *b == 0) {
        Existing::Damaged
    } else {
        Existing::Foreign
    })
}

fn foreign() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::AlreadyExists, "a different file holds the archive path")
}

/// A sibling of `path` no one else names: `<sha>.<label>-<pid>-<random>`.
fn unique_sibling(path: &Path, label: &str) -> PathBuf {
    let id = uuid::Uuid::new_v4().simple().to_string();
    path.with_extension(format!("{label}-{}-{}", std::process::id(), &id[..12]))
}

fn write(lane: &InLane<DurabilityIo>, path: &Path, content: &str) -> std::io::Result<()> {
    match existing(path, content)? {
        Existing::Intact => return Ok(()),
        Existing::Foreign => return Err(foreign()),
        Existing::Absent | Existing::Damaged => {}
    }
    // `ensureToolResultsDir`: a directory made here is the current user's only; one that exists is left as it is.
    if let Some(dir) = path.parent() {
        mixdog_statefile::create_private_dir_all(lane, dir)?;
    }
    // A temp of this write alone, created exclusively and owner-only from its first byte: a file already at the name
    // is never reused, and two persists never share one.
    let temp = unique_sibling(path, "tmp");
    let mut file = mixdog_statefile::create_new(lane, &temp, mixdog_statefile::Access::OwnerOnly, 0o600)?;
    let written = file.write_all(content.as_bytes()).and_then(|()| file.sync_all(lane));
    drop(file);
    let published = written.and_then(|()| publish(&temp, path, content));
    // After a link the temp is a second name of the artifact; after a failure it is all that is left. Either way it goes.
    let _ = std::fs::remove_file(&temp);
    published
}

fn publish(temp: &Path, path: &Path, content: &str) -> std::io::Result<()> {
    let mut repaired = false;
    loop {
        match std::fs::hard_link(temp, path) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => match existing(path, content)? {
                Existing::Intact => return Ok(()),
                Existing::Damaged if !repaired => {
                    set_aside_damaged(path, content)?;
                    repaired = true;
                }
                // Gone again since the link failed: the link is retried.
                Existing::Absent if !repaired => repaired = true,
                _ => return Err(foreign()),
            },
            other => return other,
        }
    }
}

fn set_aside_damaged(path: &Path, content: &str) -> std::io::Result<()> {
    let aside = unique_sibling(path, "damaged");
    std::fs::rename(path, &aside)?;
    if matches!(existing(&aside, content), Ok(Existing::Damaged)) {
        return std::fs::remove_file(&aside);
    }
    if std::fs::hard_link(&aside, path).is_ok() {
        return std::fs::remove_file(&aside);
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!("a file written at the archive path while it was repaired is kept at {}", aside.display()),
    ))
}

/// Archives `content`; `None` when it cannot be written (compaction is then skipped).
pub async fn persist(lane: DurabilityIo, cancel: &CancellationToken, data_dir: &Path, session: &str, stream: &'static str, content: &str) -> Option<Recovery> {
    let hex: String = Sha256::digest(content.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let path: PathBuf = data_dir.join("tool-results").join(safe_segment(session)).join(format!("{hex}.txt"));
    let (target, body) = (path.clone(), content.to_owned());
    let handle = lane.submit(cancel, move |lane| write(lane, &target, &body)).ok()?;
    handle.await.ok()?.ok()?;
    Some(Recovery { stream, path: shown_path(&path), bytes: content.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
        mixdog_rt::testing::tokens().durability_io.submit(&CancellationToken::new(), job).expect("lane").await.expect("job ran")
    }

    async fn archive(path: &Path, content: &'static str) -> std::io::Result<()> {
        let path = path.to_path_buf();
        on_lane(move |lane| write(lane, &path, content)).await
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn a_foreign_file_at_the_content_address_is_left_and_the_archive_declined() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s").join("abc.txt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "someone else's bytes").unwrap();
        assert!(archive(&path, "the captured output").await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "someone else's bytes");
        assert_eq!(names(path.parent().unwrap()), ["abc.txt"], "the refused archive left no temp file");
        // A file a crash left without data (empty, or NUL bytes of the same length) is replaced whole; the verified
        // bytes are kept.
        for damaged in [String::new(), "\0".repeat("the captured output".len())] {
            std::fs::write(&path, damaged).unwrap();
            archive(&path, "the captured output").await.unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "the captured output");
            assert_eq!(names(path.parent().unwrap()), ["abc.txt"]);
        }
        archive(&path, "the captured output").await.unwrap();
    }

    /// A file at the name an earlier build used for its temp (`<sha>.tmp-<pid>`) is someone else's: it is neither
    /// truncated nor published, and the artifact is written through a temp of its own.
    #[tokio::test]
    async fn a_file_at_a_temp_name_is_never_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s").join("abc.txt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let stale = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&stale, "a stale temp").unwrap();
        archive(&path, "secret output").await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "secret output");
        assert_eq!(std::fs::read_to_string(&stale).unwrap(), "a stale temp");
        let stale_name = stale.file_name().unwrap().to_string_lossy().into_owned();
        let mut expected = vec!["abc.txt".to_owned(), stale_name];
        expected.sort();
        assert_eq!(names(path.parent().unwrap()), expected);
    }

    /// The publish judges what is at the path when it links, not what an earlier look saw: a file that holds data is
    /// never replaced, even where a data-free one was observed before.
    #[tokio::test]
    async fn the_publish_never_replaces_a_file_that_holds_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("abc.txt");
        let temp = dir.path().join("abc.tmp-own");
        std::fs::write(&temp, "the captured output").unwrap();
        std::fs::write(&path, "written since it was seen empty").unwrap();
        assert!(publish(&temp, &path, "the captured output").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "written since it was seen empty");
        assert_eq!(names(dir.path()), ["abc.tmp-own", "abc.txt"], "nothing was set aside or left behind");
    }

    #[tokio::test]
    async fn the_archive_directory_and_file_are_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tool-results").join("s").join("abc.txt");
        archive(&path, "secret output").await.unwrap();
        let (file, folder) = (path.clone(), path.parent().unwrap().to_path_buf());
        let (file_private, folder_private) =
            on_lane(move |lane| (mixdog_statefile::is_owner_only(lane, &file).unwrap(), mixdog_statefile::is_owner_only(lane, &folder).unwrap())).await;
        assert!(file_private, "the artifact is readable by others");
        assert!(folder_private, "the archive directory is readable by others");
        assert_eq!(names(path.parent().unwrap()), ["abc.txt"]);
    }
}
