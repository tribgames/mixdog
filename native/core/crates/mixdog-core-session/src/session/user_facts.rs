//! The typed facts of a row as the live writer stores them: the one classification the
//! migration also writes (`mixdog_protocol::message_class::row_facts`), so a live row and a
//! migrated row of one message are identical.

use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;

pub use mixdog_protocol::message_class::RowFacts;
use mixdog_protocol::message_class::row_facts;
use mixdog_protocol::message_class::user_text::Blobs;
use mixdog_protocol::message_class::user_text::ReadError;
use mixdog_protocol::message_class::user_text::UserText;
use serde_json::Value;

/// The facts of a message the writer stores (`meta.taskCard` / `meta.turnEnd` go into
/// `body`); a message that is neither a room row nor user-role shows as given.
pub fn user_facts(body: &mut Value, blobs: &dyn Blobs) -> RowFacts {
    row_facts(body, &mut UserText::new(blobs)).unwrap_or(RowFacts { visible: true, prompt: None })
}

/// The prompt-attachment store (`<data>/prompt-attachments/sha256/<ab>/<hex>`) under the data
/// dir. Its reads run in an interactive-io lane job: [`Self::facts`] takes the lane.
#[derive(Clone, Debug)]
pub struct AttachmentStore(pub PathBuf);

impl AttachmentStore {
    /// [`user_facts`] of `body`, reading the store on `lane`.
    pub fn facts(&self, lane: &InLane<InteractiveIo>, body: &mut Value) -> RowFacts {
        user_facts(body, &LaneBlobs { root: &self.0, _lane: lane })
    }

    /// `readAttachmentBuffer(ref)` (`attachments/store.mjs`): the blob's bytes, read on `lane`. A blob that is
    /// gone, empty, over `MAX_ATTACHMENT_BLOB_BYTES` or whose digest is not its reference will never become
    /// readable ([`BlobError::Permanent`]); any other failure may pass.
    #[allow(clippy::disallowed_methods, reason = "runs inside an interactive-io lane job (lane proof argument)")]
    pub fn read_blob(&self, _lane: &InLane<InteractiveIo>, reference: &str) -> Result<Vec<u8>, BlobError> {
        use sha2::Digest;
        let reference_ok = reference.len() == 64 && reference.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        if !reference_ok {
            return Err(BlobError::Invalid("prompt attachment reference is invalid".into()));
        }
        let path = self.0.join("prompt-attachments/sha256").join(&reference[..2]).join(reference);
        let info = match std::fs::metadata(&path) {
            Ok(info) => info,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(BlobError::Permanent),
            Err(e) => return Err(BlobError::Transient(e.to_string())),
        };
        if !info.is_file() || info.len() == 0 || info.len() > MAX_ATTACHMENT_BLOB_BYTES {
            return Err(BlobError::Permanent);
        }
        let bytes = std::fs::read(&path).map_err(|e| BlobError::Transient(e.to_string()))?;
        if format!("{:x}", sha2::Sha256::digest(&bytes)) != reference {
            return Err(BlobError::Permanent);
        }
        Ok(bytes)
    }
}

/// `MAX_ATTACHMENT_BLOB_BYTES` (`attachments/limits.mjs`).
const MAX_ATTACHMENT_BLOB_BYTES: u64 = 64 * 1024 * 1024;

/// Why a blob could not be read.
#[derive(Debug, PartialEq, Eq)]
pub enum BlobError {
    /// `isPermanentAttachmentError`: gone, impossible size, or failed integrity.
    Permanent,
    /// The reference is not a content address (Node's `TypeError`).
    Invalid(String),
    /// A system error that may pass (`EBUSY`, `EACCES`, …): the caller must not rewrite around it.
    Transient(String),
}

/// The store as read inside a lane job (`_lane` is the proof).
struct LaneBlobs<'a> {
    root: &'a Path,
    _lane: &'a InLane<InteractiveIo>,
}

impl Blobs for LaneBlobs<'_> {
    #[allow(clippy::disallowed_methods, reason = "runs inside an interactive-io lane job (lane proof field)")]
    fn text_within(&self, hex: &str, max_bytes: u64) -> Result<Option<String>, ReadError> {
        let Some(shard) = hex.get(..2) else {
            return Err(ReadError::Other);
        };
        let path = self.root.join("prompt-attachments/sha256").join(shard).join(hex);
        match std::fs::read(path) {
            Ok(bytes) if bytes.len() as u64 > max_bytes => Ok(None),
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(ReadError::Missing),
            Err(_) => Err(ReadError::Other),
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_migrate::session::model::Row;
    use mixdog_migrate::session::restore::convert;
    use mixdog_store::schema::record::Form;

    use serde_json::json;

    use super::*;

    struct NoBlobs;

    impl Blobs for NoBlobs {
        fn text_within(&self, _hex: &str, _max: u64) -> Result<Option<String>, ReadError> {
            Err(ReadError::Missing)
        }
    }

    #[test]
    fn a_live_row_equals_the_migrated_row_of_the_same_message() {
        for message in [
            json!({ "role": "user", "content": "write a haiku" }),
            json!({ "role": "user", "content": "loaded skill", "meta": "skill" }),
            json!({ "role": "user", "content": "done", "meta": {
                "source": "task-notification",
                "execution": { "taskId": "t1", "status": "completed" } } }),
            json!({ "role": "user", "content": "steer", "meta": { "source": "steering" } }),
            json!({ "role": "user", "content": "result", "meta": { "source": "schedule-result" } }),
            json!({ "role": "user", "content": "[Request interrupted by user]" }),
            json!({ "role": "user", "content": "", "meta": { "transcript": { "displayText": "shown" } } }),
        ] {
            let mut migrated = Row {
                iid: "i".into(),
                turn: None,
                role: Some("user".into()),
                form: Form::Message,
                model: true,
                visible: true,
                archive: None,
                prompt: None,
                body: message.clone(),
            };
            convert([&mut migrated], &NoBlobs);
            let mut live = message.clone();
            let facts = user_facts(&mut live, &NoBlobs);
            assert_eq!(
                (facts.visible, facts.prompt, live),
                (migrated.visible, migrated.prompt, migrated.body),
                "{message}"
            );
        }
    }
}
