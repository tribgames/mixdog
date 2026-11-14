//! The typed facts of a row as the live writer stores them: the one classification the
//! migration also writes (`mixdog_protocol::message_class::row_facts`), so a live row and a
//! migrated row of one message are identical. One exception: the live writer also lists a Goal
//! entry's prompt (`start_run_read`), which the migration leaves unlisted.

use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;

// `MAX_ATTACHMENT_BLOB_BYTES` (`attachments/limits.mjs`).
use mixdog_protocol::MAX_BLOB_BYTES;
pub use mixdog_protocol::message_class::RowFacts;
use mixdog_protocol::message_class::row_facts;
use mixdog_protocol::message_class::user_text::Blobs;
use mixdog_protocol::message_class::user_text::UserText;
use mixdog_store::blobs::BlobError as StoreError;
use mixdog_store::blobs::BlobStore;
use mixdog_store::blobs::LaneBlobs;
use mixdog_store::blobs::digest_of;
use mixdog_store::blobs::digest_of_reference;
use mixdog_store::blobs::hex;
use mixdog_store::fsio::Access;
use serde_json::Value;

/// The facts of a message the writer stores (`meta.taskCard` / `meta.turnEnd` go into
/// `body`); a message that is neither a room row nor user-role shows as given.
pub fn user_facts(body: &mut Value, blobs: &dyn Blobs) -> RowFacts {
    row_facts(body, &mut UserText::new(blobs)).unwrap_or(RowFacts { visible: true, prompt: None })
}

/// The prompt-attachment store over the process's [`BlobStore`] (`<data>/prompt-attachments/sha256/<ab>/<hex>`): the blob
/// store's layout, publication and verified reads, with the intake's refusals and Node's error classes. Every call runs in an
/// interactive-io lane job and takes the lane.
#[derive(Clone)]
pub struct AttachmentStore(pub BlobStore);

/// A failed read of the blob store as Node classes it: a system error may pass (the OS's message), anything else (gone, too
/// large, failed integrity) never becomes readable.
fn read_failure(error: StoreError) -> BlobError {
    match error {
        StoreError::Io(error) => BlobError::Transient(error.source.to_string()),
        StoreError::ItemTooLarge { .. } | StoreError::Missing { .. } | StoreError::Corrupt { .. } => BlobError::Permanent,
    }
}

impl AttachmentStore {
    /// `saveBuffer(bytes)` (`attachments/store.mjs:135-185`): keeps `bytes` at their content address and answers the reference.
    /// Empty bytes and bytes over `MAX_ATTACHMENT_BLOB_BYTES` are refused with Node's sentences (`store.mjs:137,139`), so intake
    /// refuses what restore could never read. An existing blob is reused only when it is these bytes (`store.mjs:146-160`); a
    /// truncated, foreign or unreadable one is replaced. The blob is published whole, durable and owner-only (`writeFileAtomicSync`,
    /// `store.mjs:168`).
    pub fn write_blob(&self, lane: &InLane<InteractiveIo>, bytes: &[u8]) -> Result<String, BlobError> {
        if bytes.is_empty() {
            return Err(BlobError::Invalid("prompt attachment is empty".into()));
        }
        if bytes.len() as u64 > MAX_BLOB_BYTES {
            return Err(BlobError::Invalid("prompt attachment exceeds the 64 MiB input limit".into()));
        }
        match self.0.put_with(lane, bytes, Access::OwnerOnly) {
            Ok(pin) => Ok(hex(pin.digest()).to_owned()),
            // A concurrent writer may have published the same content first (`store.mjs:170`).
            Err(error) => {
                let digest = digest_of(bytes);
                match self.0.read(lane, &digest) {
                    Ok(_) => Ok(hex(&digest).to_owned()),
                    Err(_) => Err(BlobError::Transient(error.to_string())),
                }
            }
        }
    }

    /// `attachmentBlobSize`'s `statSync(attachmentPath(ref)).size` (`attachments/store.mjs:410-417`), read on `lane`: the size
    /// of the file at the reference's address, `None` when there is none (ENOENT); any other failure may pass.
    pub fn blob_len(&self, lane: &InLane<InteractiveIo>, reference: &str) -> Result<Option<u64>, BlobError> {
        let digest = digest_of_reference(reference).ok_or_else(|| BlobError::Invalid("prompt attachment reference is invalid".into()))?;
        self.0.len(lane, &digest).map_err(read_failure)
    }

    /// [`user_facts`] of `body`, reading the store on `lane` ([`LaneBlobs`], `readAttachmentTextWithin`).
    pub fn facts(&self, lane: &InLane<InteractiveIo>, body: &mut Value) -> RowFacts {
        user_facts(body, &LaneBlobs { blobs: &self.0, lane })
    }

    /// `readAttachmentBuffer(ref)` (`attachments/store.mjs`): the blob's bytes, read on `lane`. A blob that is
    /// gone, empty, over `MAX_ATTACHMENT_BLOB_BYTES` or whose digest is not its reference will never become
    /// readable ([`BlobError::Permanent`]); any other failure may pass.
    pub fn read_blob(&self, lane: &InLane<InteractiveIo>, reference: &str) -> Result<Vec<u8>, BlobError> {
        let digest = digest_of_reference(reference).ok_or_else(|| BlobError::Invalid("prompt attachment reference is invalid".into()))?;
        // `statSync(path)`: anything but a file of 1 byte to the limit is invalid for good.
        match mixdog_statefile::metadata(lane, &self.0.path(&digest)) {
            Ok(info) if info.is_file() && info.len() > 0 && info.len() <= MAX_BLOB_BYTES => self.0.read(lane, &digest).map_err(read_failure),
            Ok(_) => Err(BlobError::Permanent),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(BlobError::Permanent),
            Err(error) => Err(BlobError::Transient(error.to_string())),
        }
    }
}

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

#[cfg(test)]
mod tests {
    use mixdog_migrate::session::model::Row;
    use mixdog_migrate::session::restore::convert;
    use mixdog_protocol::message_class::user_text::ReadError;
    use mixdog_store::schema::record::Form;

    use serde_json::json;

    use super::*;

    struct NoBlobs;

    impl Blobs for NoBlobs {
        fn text_within(&self, _hex: &str, _max: u64) -> Result<Option<String>, ReadError> {
            Err(ReadError::Missing)
        }
    }

    /// `write_blob` run on an interactive-io lane, as intake runs it.
    async fn write(store: &AttachmentStore, bytes: Vec<u8>) -> Result<String, BlobError> {
        let store = store.clone();
        let tokens = mixdog_rt::testing::tokens();
        mixdog_core_base::support::on_lane(tokens.interactive_io, &tokio_util::sync::CancellationToken::new(), move |lane| store.write_blob(lane, &bytes)).await.unwrap()
    }

    #[tokio::test]
    async fn a_pasted_text_is_refused_at_intake_as_node_refuses_it_and_a_cut_blob_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let store = AttachmentStore(BlobStore::new(dir.path()));
        // store.mjs:137,139: refused when the prompt is taken in, never stored for restore to reject.
        assert_eq!(write(&store, Vec::new()).await, Err(BlobError::Invalid("prompt attachment is empty".into())));
        let over = vec![b'a'; MAX_BLOB_BYTES as usize + 1];
        assert_eq!(write(&store, over).await, Err(BlobError::Invalid("prompt attachment exceeds the 64 MiB input limit".into())));
        assert!(!dir.path().join("prompt-attachments").exists(), "nothing is stored for a refusal");
        // A blob a crash cut short sits at the content address: the next write of the same text replaces it (store.mjs:146-160).
        let text = b"pasted text".to_vec();
        let reference = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(&text));
        let path = dir.path().join("prompt-attachments/sha256").join(&reference[..2]).join(&reference);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"pasted").unwrap();
        assert_eq!(write(&store, text.clone()).await, Ok(reference.clone()));
        assert_eq!(std::fs::read(&path).unwrap(), text);
        // Published whole: no tmp is left beside it.
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    /// `saveBuffer` (store.mjs:146-161): a blob at the content address that cannot be read counts as absent; it is written
    /// again (the publish's rename replaces it), never a failure that may pass.
    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test setup: the blob is made unreadable, then read back")]
    async fn an_unreadable_blob_at_the_address_is_written_again() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = AttachmentStore(BlobStore::new(dir.path()));
        let text = b"pasted text".to_vec();
        let reference = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(&text));
        let path = dir.path().join("prompt-attachments/sha256").join(&reference[..2]).join(&reference);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(write(&store, text.clone()).await, Ok(reference));
        assert_eq!(std::fs::read(&path).unwrap(), text);
    }

    /// A Goal entry's prompt shows no row of its own but is listed, in the migration's output as in a live row: a failed end recorded on
    /// it is restored from the history page that lists it.
    #[test]
    fn a_goal_prompt_is_listed_though_it_shows_no_row() {
        for source in ["goal-continuation", "goal-closeout"] {
            let mut body = json!({ "role": "user", "content": "", "meta": { "source": source } });
            let facts = user_facts(&mut body, &NoBlobs);
            assert_eq!((facts.visible, facts.prompt), (true, None), "{source}");
        }
        let mut hook = json!({ "role": "user", "content": "loaded", "meta": "hook" });
        assert!(!user_facts(&mut hook, &NoBlobs).visible);
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
