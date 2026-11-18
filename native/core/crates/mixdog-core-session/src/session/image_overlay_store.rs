//! The persisted image-recovery overlay of a session (`<data>/image-overlay/<session>.json`), written atomically beside the
//! transcript, never inside it: a recovery action is a projection edit and the history keeps every original record. A save
//! failure is returned to the caller to report; nothing is silently kept only in memory.

use std::path::Path;
use std::path::PathBuf;

use mixdog_core_api::domain::image_overlay::ImageOverlay;
use mixdog_store::fsio::Access;
use mixdog_store::fsio::publish_file_with;

const DIR: &str = "image-overlay";

/// Why an overlay could not be loaded or saved.
#[derive(Debug, PartialEq, Eq)]
pub enum OverlayError {
    /// The session id cannot name a file.
    BadSession,
    /// The file exists and is not a readable version-1 overlay; it is left in place for repair.
    Unreadable(String),
    Io(String),
    /// The action names no image or message of the conversation, or nothing it could undo: nothing was changed.
    Unaddressed,
}

fn file(data_dir: &Path, session: &str) -> Result<PathBuf, OverlayError> {
    let ok = !session.is_empty() && session.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !ok {
        return Err(OverlayError::BadSession);
    }
    Ok(data_dir.join(DIR).join(format!("{session}.json")))
}

/// The session's overlay; empty when none was saved.
#[allow(clippy::disallowed_methods, reason = "runs inside an interactive-io lane job")]
pub fn load(data_dir: &Path, session: &str) -> Result<ImageOverlay, OverlayError> {
    let path = file(data_dir, session)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ImageOverlay::default()),
        Err(error) => return Err(OverlayError::Io(error.to_string())),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| OverlayError::Unreadable(error.to_string()))?;
    ImageOverlay::from_json(&value).ok_or_else(|| OverlayError::Unreadable("not a version-1 image overlay".into()))
}

/// Replace the session's overlay atomically.
#[allow(clippy::disallowed_methods, reason = "runs inside an interactive-io lane job")]
pub fn save(data_dir: &Path, session: &str, overlay: &ImageOverlay) -> Result<(), OverlayError> {
    let path = file(data_dir, session)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| OverlayError::Io(error.to_string()))?;
    }
    let bytes = serde_json::to_vec(&overlay.to_json()).map_err(|error| OverlayError::Io(error.to_string()))?;
    publish_file_with(&path, &bytes, Access::Inherit).map_err(|error| OverlayError::Io(error.to_string()))
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::image_overlay::PartKey;

    use super::*;

    #[test]
    fn overlay_round_trips_across_a_restart_and_a_damaged_file_is_reported() {
        let data = tempfile::tempdir().expect("data");
        assert!(load(data.path(), "sess_a").unwrap().is_empty());
        let mut overlay = ImageOverlay::default();
        overlay.omit(PartKey { message_id: "m1".into(), part: 0 });
        overlay.start_new_context_at("m4".into());
        save(data.path(), "sess_a", &overlay).unwrap();
        assert_eq!(load(data.path(), "sess_a").unwrap(), overlay);
        std::fs::write(data.path().join(DIR).join("sess_a.json"), b"{").unwrap();
        assert!(matches!(load(data.path(), "sess_a"), Err(OverlayError::Unreadable(_))));
        assert_eq!(save(data.path(), "../x", &overlay), Err(OverlayError::BadSession));
    }
}
