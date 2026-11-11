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
    /// `pruneOffloadSession`: deletes the session's sidecars at least ten minutes old (at `now_ms`)
    /// that `transcripts` (the session's message lists, serialized as `JSON.stringify` writes them)
    /// neither names by path or file name nor reaches through the archives it names. Best-effort: an
    /// unreadable listing or archive deletes nothing.
    pub async fn prune(&self, transcripts: String, now_ms: u64) {
        let dir = self.dir.clone();
        let Ok(job) = self.io.durability.submit(&CancellationToken::new(), move |lane| prune_dir(lane, &dir, &transcripts, now_ms)) else {
            return;
        };
        let _ = job.await;
    }
}

#[allow(clippy::disallowed_methods, reason = "takes the durability lane's proof: it runs inside a lane job body")]
fn prune_dir(_lane: &InLane<DurabilityIo>, dir: &Path, transcripts: &str, now_ms: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let candidates: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let modified = entry.metadata().ok()?.modified().ok()?;
            let modified_ms = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
            (name.ends_with(".txt") && now_ms.saturating_sub(modified_ms) >= PRUNE_MIN_AGE_MS).then(|| (name, entry.path()))
        })
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
    let mut retain = |reachable: &[String]| {
        unreferenced.retain(|(name, _)| !reachable.contains(name));
        !unreferenced.is_empty()
    };
    if !retain(&reachable) {
        return;
    }
    let mut i = 0;
    while i < reachable.len() {
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
    for (_, path) in unreferenced {
        let _ = std::fs::remove_file(path);
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
            match existing_state(lane, &path, &sha, len) {
                State::Intact => true,
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

    #[test]
    fn line_counts_follow_the_split_rule() {
        assert_eq!(split_lines(""), 0);
        assert_eq!(split_lines("a"), 1);
        assert_eq!(split_lines("a\n"), 2);
    }
}
