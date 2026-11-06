//! Archive of a full captured stream (`persistToolResultArtifactSync`): a content-addressed file
//! `<data>/tool-results/<session>/<sha256>.txt`, so compacted output can be read back whole.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "lane job bodies are the sanctioned home of blocking file I/O (clippy.toml)"
)]

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use sha2::Digest;
use sha2::Sha256;
use tokio_util::sync::CancellationToken;

use super::compact::Recovery;
use super::jobs::shown_path;

/// `safeSessionSegment`: every character outside `[A-Za-z0-9_-]` becomes `_`, at most 200.
fn safe_segment(session: &str) -> String {
    let mapped: String = session
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let cut: String = mapped.encode_utf16().take(200).map(|u| char::from_u32(u32::from(u)).unwrap_or('_')).collect();
    if cut.is_empty() { "_invalid".to_owned() } else { cut }
}

fn write(path: &Path, content: &str) -> std::io::Result<()> {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.is_file() && meta.len() == content.len() as u64 && std::fs::read(path)? == content.as_bytes() {
            return Ok(());
        }
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

/// Archives `content`; `None` when it cannot be written (compaction is then skipped).
pub async fn persist(
    lane: MaintenanceIo,
    cancel: &CancellationToken,
    data_dir: &Path,
    session: &str,
    stream: &'static str,
    content: &str,
) -> Option<Recovery> {
    let hex: String = Sha256::digest(content.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let path: PathBuf = data_dir.join("tool-results").join(safe_segment(session)).join(format!("{hex}.txt"));
    let (target, body) = (path.clone(), content.to_owned());
    let handle = lane.submit(cancel, move |_| write(&target, &body)).ok()?;
    handle.await.ok()?.ok()?;
    Some(Recovery { stream, path: shown_path(&path), bytes: content.len() })
}
