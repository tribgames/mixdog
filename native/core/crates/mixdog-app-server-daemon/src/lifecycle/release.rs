//! `runtime/last-exit.json` (LR §5.3 step 4, §6.1 terminate).

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the release record is written once, by the exiting thread, with no runtime left"
)]

use std::io::Write;
use std::path::Path;

use serde::Serialize;

pub const LAST_EXIT_FILE: &str = "last-exit.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastExit {
    pub reason: String,
    pub instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stalled_ms: Option<u64>,
    /// The release step that was still running at its budget and was abandoned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stuck_step: Option<String>,
}

/// Atomic replace, file fsync, then (where the platform allows it) directory fsync.
pub fn write_last_exit(runtime_root: &Path, record: &LastExit) -> std::io::Result<()> {
    std::fs::create_dir_all(runtime_root)?;
    let target = runtime_root.join(LAST_EXIT_FILE);
    let staged = runtime_root.join(format!("{LAST_EXIT_FILE}.tmp"));
    let mut file = std::fs::File::create(&staged)?;
    file.write_all(&serde_json::to_vec(record).map_err(std::io::Error::other)?)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&staged, &target)?;
    #[cfg(unix)]
    std::fs::File::open(runtime_root)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let record = |reason: &str, stalled| LastExit {
            reason: reason.into(),
            instance_id: "i".into(),
            stalled_ms: stalled,
            stuck_step: None,
        };
        write_last_exit(dir.path(), &record("update", None)).unwrap();
        write_last_exit(dir.path(), &record("userTerminated", Some(7))).unwrap();
        let text = std::fs::read_to_string(dir.path().join(LAST_EXIT_FILE)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["reason"], "userTerminated");
        assert_eq!(json["instanceId"], "i");
        assert_eq!(json["stalledMs"], 7);
        assert!(!dir.path().join("last-exit.json.tmp").exists());
    }
}
