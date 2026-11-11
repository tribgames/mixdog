//! `ArtifactStore` over the data dir: `<data>/tool-results/<session>/<sha256>.txt`, owner-only,
//! content-addressed and verified, exactly as the earlier runtime laid it out (the model sees
//! the path, so it is part of the contract).

use std::io;
use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use mixdog_agent::offload::Artifact;
use mixdog_agent::offload::ArtifactStore;
use mixdog_store::fsio::Access;
use mixdog_store::fsio::publish_file_with;
use sha2::Digest;
use sha2::Sha256;

pub struct ToolResultArtifacts {
    io: ToolIo,
    dir: PathBuf,
    session_ok: bool,
}

/// Session ids are path segments: anything outside `[A-Za-z0-9_-]` becomes `_`, so a `..` or a
/// slash cannot leave the tool-results root.
pub fn safe_segment(session_id: &str) -> String {
    let cleaned: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(200)
        .collect();
    if cleaned.is_empty() { "_invalid".to_owned() } else { cleaned }
}

fn split_lines(text: &str) -> usize {
    if text.is_empty() { 0 } else { text.bytes().filter(|b| *b == b'\n').count() + 1 }
}

/// The path as shown to the model (`normalizeOutputPath`: forward slashes and an uppercase drive
/// letter on Windows).
fn display(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if !cfg!(windows) {
        return text;
    }
    let text = text.replace('\\', "/");
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(d), Some(':')) if d.is_ascii_lowercase() => format!("{}{}", d.to_ascii_uppercase(), &text[1..]),
        _ => text,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What a crash leaves of a file whose data never reached disk: only NUL and whitespace.
fn holds_no_data(bytes: &[u8]) -> bool {
    bytes.iter().all(|b| matches!(b, 0 | b' ' | b'\t' | b'\n' | b'\r'))
}

enum State {
    Absent,
    Intact,
    /// A file a crash left without data: replaced whole.
    Damaged,
    /// Anything else (other bytes, a link, a directory, unreadable): evidence, never touched.
    Foreign,
}

#[allow(clippy::disallowed_methods, reason = "takes the durability lane's proof: it runs inside a lane job body")]
fn existing_state(_lane: &InLane<DurabilityIo>, path: &Path, sha256: &str, bytes: u64) -> State {
    let info = match std::fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return State::Absent,
        Err(_) => return State::Foreign,
    };
    if !info.is_file() {
        return State::Foreign;
    }
    if info.len() != bytes {
        return if info.len() == 0 { State::Damaged } else { State::Foreign };
    }
    let Ok(found) = std::fs::read(path) else {
        return State::Foreign;
    };
    if hex(&Sha256::digest(&found)) == sha256 {
        State::Intact
    } else if holds_no_data(&found) {
        State::Damaged
    } else {
        State::Foreign
    }
}

impl ToolResultArtifacts {
    /// `data_dir` is the data root; `session_id` names the session whose results are stored.
    pub fn new(io: ToolIo, data_dir: &Path, session_id: &str) -> Self {
        Self { io, dir: data_dir.join("tool-results").join(safe_segment(session_id)), session_ok: !session_id.is_empty() }
    }

    fn describe(&self, content: &str) -> (PathBuf, Artifact) {
        let sha256 = hex(&Sha256::digest(content.as_bytes()));
        let path = self.dir.join(format!("{sha256}.txt"));
        let artifact = Artifact { display_path: display(&path), path: path.to_string_lossy().into_owned(), lines: split_lines(content), sha256 };
        (path, artifact)
    }
}

/// Only a sidecar at least this old can be pruned (`OFFLOAD_PRUNE_MIN_AGE_MS`).
const PRUNE_MIN_AGE_MS: u64 = 10 * 60 * 1000;

/// Held while a sidecar is checked for reuse and while a prune deletes: a reused sidecar is
/// touched first, so a prune either sees it young or deletes it before the reuse finds it absent
/// and writes it again. A turn's tool result is never lost to a prune running beside it.
static SIDECARS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn sidecars() -> std::sync::MutexGuard<'static, ()> {
    SIDECARS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn age_ms(modified: std::time::SystemTime, now_ms: u64) -> Option<u64> {
    let modified_ms = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(now_ms.saturating_sub(modified_ms))
}

/// A reused sidecar is young again: its mtime is now.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "takes the durability lane's proof: it runs inside a lane job body")]
fn touch(_lane: &InLane<DurabilityIo>, path: &Path) {
    if let Ok(file) = std::fs::File::options().write(true).open(path) {
        let _ = file.set_modified(std::time::SystemTime::now());
    }
}

/// The `\b[a-f0-9]{64}\.txt\b` names in `text`, in order.
fn sidecar_names(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    let mut names = Vec::new();
    let mut i = 0;
    while i + 68 <= bytes.len() {
        let found = (i == 0 || !word(bytes[i - 1]))
            && bytes[i..i + 64].iter().all(|b| hex(*b))
            && &bytes[i + 64..i + 68] == b".txt"
            && bytes.get(i + 68).is_none_or(|b| !word(*b));
        if found {
            names.push(text[i..i + 68].to_owned());
            i += 68;
        } else {
            i += 1;
        }
    }
    names
}

impl ToolResultArtifacts {
    /// `pruneOffloadSession`'s listing: the session's sidecars, by name only (one directory listing: a
    /// sidecar's age is read by `prune` once nothing the session names keeps it); none when there are none
    /// or the directory cannot be listed.
    pub async fn prune_candidates(&self) -> Vec<PathBuf> {
        let dir = self.dir.clone();
        let Ok(job) = self.io.durability.submit(&CancellationToken::new(), move |lane| listed_sidecars(lane, &dir)) else {
            return Vec::new();
        };
        job.await.unwrap_or_default()
    }

    /// The rest of `pruneOffloadSession`: of `candidates`, deletes the sidecars `transcripts` (the
    /// session's message lists, serialized as `JSON.stringify` writes them) neither names by path or
    /// file name nor reaches through the archives it names, and old at `now_ms`. Best-effort: an
    /// unreadable archive deletes nothing (a later prune, the next open's, finds it again).
    pub async fn prune(&self, candidates: Vec<PathBuf>, transcripts: String, now_ms: u64) {
        if candidates.is_empty() {
            return;
        }
        let dir = self.dir.clone();
        let Ok(job) = self.io.durability.submit(&CancellationToken::new(), move |lane| prune_dir(lane, &dir, candidates, &transcripts, now_ms)) else {
            return;
        };
        let _ = job.await;
    }

}

#[allow(clippy::disallowed_methods, reason = "takes the durability lane's proof: it runs inside a lane job body")]
fn listed_sidecars(_lane: &InLane<DurabilityIo>, dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries.flatten().filter(|entry| entry.file_name().to_string_lossy().ends_with(".txt")).map(|entry| entry.path()).collect()
}

/// Every archive a prune has read, in order (tests count them).
#[cfg(test)]
static ARCHIVE_READS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

#[allow(clippy::disallowed_methods, reason = "takes the durability lane's proof: it runs inside a lane job body")]
fn prune_dir(_lane: &InLane<DurabilityIo>, dir: &Path, candidates: Vec<PathBuf>, transcripts: &str, now_ms: u64) {
    // Only this session's own directory is pruned.
    let candidates: Vec<(String, PathBuf)> = candidates
        .into_iter()
        .filter(|path| path.parent() == Some(dir))
        .filter_map(|path| Some((path.file_name()?.to_string_lossy().into_owned(), path)))
        .collect();
    if candidates.is_empty() {
        return;
    }
    let fold = |text: &str| if cfg!(windows) { text.to_lowercase() } else { text.to_owned() };
    let haystack = fold(transcripts);
    let mut unreferenced: Vec<(String, PathBuf)> = candidates
        .into_iter()
        .filter(|(name, path)| ![display(path), name.clone()].iter().any(|needle| haystack.contains(&fold(needle))))
        .collect();
    let mut reachable: Vec<String> = Vec::new();
    for name in sidecar_names(&haystack) {
        if !reachable.contains(&name) {
            reachable.push(name);
        }
    }
    let old = |path: &Path| std::fs::metadata(path).ok().and_then(|info| info.modified().ok()).and_then(|modified| age_ms(modified, now_ms)).is_some_and(|age| age >= PRUNE_MIN_AGE_MS);
    unreferenced.retain(|(name, _)| !reachable.contains(name));
    // Only an old sidecar can be deleted: without one, the archives are not walked.
    unreferenced.retain(|(_, path)| old(path));
    let mut retain = |reachable: &[String]| {
        unreferenced.retain(|(name, _)| !reachable.contains(name));
        !unreferenced.is_empty()
    };
    if !retain(&reachable) {
        return;
    }
    let mut i = 0;
    while i < reachable.len() {
        #[cfg(test)]
        ARCHIVE_READS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(dir.join(&reachable[i]));
        // An unreadable root must not destroy recovery evidence.
        let Ok(text) = std::fs::read_to_string(dir.join(&reachable[i])) else { return };
        let mut grew = false;
        for name in sidecar_names(&text) {
            if !reachable.contains(&name) {
                reachable.push(name);
                grew = true;
            }
        }
        if grew && !retain(&reachable) {
            return;
        }
        i += 1;
    }
    let _held = sidecars();
    for (_, path) in unreferenced {
        // Reused since it was listed: a turn holds it now.
        let still_old = old(&path);
        // Best-effort, as Node's `unlink(...).catch(() => {})`: a sidecar that cannot be deleted stays.
        if still_old {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[async_trait]
impl ArtifactStore for ToolResultArtifacts {
    async fn persist(&self, content: &str) -> Option<Artifact> {
        if !self.session_ok {
            return None;
        }
        let (path, artifact) = self.describe(content);
        let text = content.to_owned();
        let sha = artifact.sha256.clone();
        let job = self.io.durability.submit(&CancellationToken::new(), move |lane| {
            let len = text.len() as u64;
            let _held = sidecars();
            match existing_state(lane, &path, &sha, len) {
                State::Intact => {
                    touch(lane, &path);
                    true
                }
                State::Foreign => false,
                State::Damaged | State::Absent => {
                    publish_file_with(&path, text.as_bytes(), Access::OwnerOnly).is_ok()
                        && matches!(existing_state(lane, &path, &sha, len), State::Intact)
                }
            }
        });
        job.ok()?.await.ok()?.then_some(artifact)
    }

    async fn preview(&self, content: &str) -> Option<Artifact> {
        self.session_ok.then(|| self.describe(content).1)
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup writes and reads fixture files")]
mod tests {
    use super::*;

    fn io() -> ToolIo {
        let tokens = mixdog_rt::testing::tokens();
        ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io }
    }

    #[tokio::test]
    async fn persist_lays_the_file_out_as_the_earlier_runtime_did() {
        let data = tempfile::tempdir().unwrap();
        let store = ToolResultArtifacts::new(io(), data.path(), "sess_1/../x");
        let text = "a\nb\nc";
        let preview = store.preview(text).await.unwrap();
        assert!(!data.path().join("tool-results").exists(), "a preview creates nothing");
        let artifact = store.persist(text).await.unwrap();
        // sha256("a\nb\nc")
        assert_eq!(artifact.sha256, hex(&Sha256::digest(b"a\nb\nc")));
        assert_eq!(artifact.sha256, preview.sha256);
        assert_eq!(artifact.lines, 3);
        let file = data.path().join("tool-results/sess_1____x").join(format!("{}.txt", artifact.sha256));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        assert_eq!(artifact.display_path, display(&file));
        // an intact file is reused; a data-free one is replaced; a foreign one refuses
        assert!(store.persist(text).await.is_some());
        std::fs::write(&file, vec![0u8; text.len()]).unwrap();
        assert!(store.persist(text).await.is_some());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        std::fs::write(&file, "x\ny\nz").unwrap();
        assert!(store.persist(text).await.is_none());
    }

    #[tokio::test]
    async fn no_session_means_no_artifact() {
        let data = tempfile::tempdir().unwrap();
        assert!(ToolResultArtifacts::new(io(), data.path(), "").persist("x").await.is_none());
    }

    /// `pruneOffloadSession` (taken over from `replay-k1-tools-scm` d43b635b38): an old sidecar the transcript names
    /// (by path or name), or that an archive it names names, stays; an old unnamed one goes; a young one stays whatever
    /// names it.
    #[tokio::test]
    async fn a_compaction_prunes_the_old_sidecars_the_live_transcript_no_longer_reaches() {
        let data = tempfile::tempdir().unwrap();
        let store = ToolResultArtifacts::new(io(), data.path(), "sess_p");
        let dir = data.path().join("tool-results/sess_p");
        std::fs::create_dir_all(&dir).unwrap();
        let name = |c: char| format!("{}.txt", c.to_string().repeat(64));
        let (shown, chained, gone, young) = (name('a'), name('b'), name('c'), name('d'));
        std::fs::write(dir.join(&shown), format!("see {chained}")).unwrap();
        std::fs::write(dir.join(&chained), "end").unwrap();
        std::fs::write(dir.join(&gone), "old").unwrap();
        std::fs::write(dir.join(&young), "new").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(11 * 60);
        for file in [&shown, &chained, &gone] {
            std::fs::File::options().write(true).open(dir.join(file)).unwrap().set_modified(old).unwrap();
        }
        let haystack = serde_json::json!([{"content": format!("[tool output offloaded: {}]", display(&dir.join(&shown)))}]).to_string();
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        store.prune(store.prune_candidates().await, haystack, now_ms).await;
        let left: Vec<bool> = [&shown, &chained, &gone, &young].iter().map(|file| dir.join(file).exists()).collect();
        assert_eq!(left, [true, true, false, true]);
    }

    /// A prune with nothing to delete (every old sidecar named, the unnamed one young) lists the folder and reads no
    /// archive; once the unnamed one is old, the archive the transcript names is read and the unnamed one goes.
    #[tokio::test]
    async fn a_prune_with_nothing_old_and_unnamed_reads_no_archive() {
        let data = tempfile::tempdir().unwrap();
        let store = ToolResultArtifacts::new(io(), data.path(), "sess_r");
        let dir = data.path().join("tool-results/sess_r");
        std::fs::create_dir_all(&dir).unwrap();
        let name = |c: char| format!("{}.txt", c.to_string().repeat(64));
        let (archive, young) = (name('a'), name('c'));
        std::fs::write(dir.join(&archive), "older output is elsewhere").unwrap();
        std::fs::write(dir.join(&young), "new").unwrap();
        let aged = |file: &str| std::fs::File::options().write(true).open(dir.join(file)).unwrap().set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(11 * 60)).unwrap();
        aged(&archive);
        let haystack = serde_json::json!([{ "content": format!("the archive is at {}", display(&dir.join(&archive))) }]).to_string();
        let now_ms = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let reads = || ARCHIVE_READS.lock().unwrap().iter().filter(|path| path.starts_with(&dir)).count();
        store.prune(store.prune_candidates().await, haystack.clone(), now_ms()).await;
        assert_eq!((reads(), dir.join(&archive).exists(), dir.join(&young).exists()), (0, true, true));
        aged(&young);
        store.prune(store.prune_candidates().await, haystack, now_ms()).await;
        assert_eq!((reads(), dir.join(&archive).exists(), dir.join(&young).exists()), (1, true, false));
    }

    #[test]
    fn line_counts_follow_the_split_rule() {
        assert_eq!(split_lines(""), 0);
        assert_eq!(split_lines("a"), 1);
        assert_eq!(split_lines("a\n"), 2);
    }
}
