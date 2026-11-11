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

/// `OFFLOAD_PRUNE_MIN_AGE_MS`: a sidecar younger than this is never pruned (an in-flight turn's).
const PRUNE_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Every `\b[a-f0-9]{64}\.txt\b` of `text`: the archive names a text refers to.
fn archive_names(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut names = Vec::new();
    let mut from = 0;
    while let Some(found) = text[from..].find(".txt") {
        let dot = from + found;
        from = dot + 4;
        if dot < 64 || bytes.get(dot + 4).is_some_and(|b| word(*b)) {
            continue;
        }
        let start = dot - 64;
        if bytes[start..dot].iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) && (start == 0 || !word(bytes[start - 1])) {
            names.push(text[start..dot + 4].to_owned());
        }
    }
    names
}

/// `pruneOffloadSession` over the session's folder, on a maintenance-lane job: the sidecars at least
/// [`PRUNE_MIN_AGE`] old that `haystack` (the serialized live transcript) names neither by path nor
/// by file name, and that no archive reachable from it names, are removed. Anything unreadable on the
/// way keeps every file.
#[allow(clippy::disallowed_methods, reason = "takes the maintenance lane's proof: it runs inside a lane job body")]
fn prune_offloads(_lane: &InLane<mixdog_rt::MaintenanceIo>, dir: &Path, haystack: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    let candidates: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".txt") {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            // `Date.now() - mtimeMs < OFFLOAD_PRUNE_MIN_AGE_MS`: too young (a future time is too).
            (now.duration_since(modified).ok()? >= PRUNE_MIN_AGE).then(|| (name, entry.path()))
        })
        .collect();
    if candidates.is_empty() {
        return;
    }
    let fold = |text: &str| if cfg!(windows) { text.to_lowercase() } else { text.to_owned() };
    let haystack = fold(haystack);
    let mut unreferenced: Vec<(String, PathBuf)> =
        candidates.into_iter().filter(|(name, path)| ![display(path), name.clone()].iter().any(|needle| haystack.contains(&fold(needle)))).collect();
    let mut reachable: std::collections::HashSet<String> = archive_names(&haystack).into_iter().collect();
    let mut retain_reachable = |reachable: &std::collections::HashSet<String>| {
        unreferenced.retain(|(name, _)| !reachable.contains(name));
        !unreferenced.is_empty()
    };
    if !retain_reachable(&reachable) {
        return;
    }
    let mut pending: Vec<String> = reachable.iter().cloned().collect();
    let mut at = 0;
    while at < pending.len() {
        let Ok(bytes) = std::fs::read(dir.join(&pending[at])) else { return };
        at += 1;
        let mut grew = false;
        for name in archive_names(&String::from_utf8_lossy(&bytes)) {
            if reachable.insert(name.clone()) {
                pending.push(name);
                grew = true;
            }
        }
        if grew && !retain_reachable(&reachable) {
            return;
        }
    }
    for (_, path) in &unreferenced {
        let _ = std::fs::remove_file(path);
    }
}

impl ToolResultArtifacts {
    /// `pruneOffloadSession(sessionId, getMessages)`: after a compaction, the session's sidecars the live transcript
    /// (`haystack`, its serialization) can no longer reach are removed. Best effort.
    pub async fn prune(&self, haystack: String) {
        if !self.session_ok {
            return;
        }
        let dir = self.dir.clone();
        if let Ok(job) = self.io.maintenance.submit(&CancellationToken::new(), move |lane| prune_offloads(lane, &dir, &haystack)) {
            let _ = job.await;
        }
    }

    /// `data_dir` is the data root; `session_id` names the session whose results are stored.
    pub fn new(io: ToolIo, data_dir: &Path, session_id: &str) -> Self {
        Self { io, dir: data_dir.join("tool-results").join(safe_segment(session_id)), session_ok: !session_id.is_empty() }
    }

    fn describe(&self, content: &str) -> (PathBuf, Artifact) {
        let sha256 = hex(&Sha256::digest(content.as_bytes()));
        let path = self.dir.join(format!("{sha256}.txt"));
        let artifact = Artifact { display_path: display(&path), lines: split_lines(content), sha256 };
        (path, artifact)
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

    /// `pruneOffloadSession`: an old sidecar the transcript names (by path or name), or that an archive it names names, stays;
    /// an old unnamed one goes; a young one stays whatever names it.
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
        store.prune(haystack).await;
        let left: Vec<bool> = [&shown, &chained, &gone, &young].iter().map(|file| dir.join(file).exists()).collect();
        assert_eq!(left, [true, true, false, true]);
    }

    #[test]
    fn line_counts_follow_the_split_rule() {
        assert_eq!(split_lines(""), 0);
        assert_eq!(split_lines("a"), 1);
        assert_eq!(split_lines("a\n"), 2);
    }
}
