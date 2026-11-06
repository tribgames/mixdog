//! What the context signatures of a recovered turn read besides the rows
//! ([`AttachmentBytes`]): the preserved 1.4.5 attachment blobs, and Node's office extractor
//! through the extension host.

use std::sync::Arc;

use base64::Engine as _;
use mixdog_agent::compact::pressure::AttachmentBytes;
use mixdog_agent::compact::pressure::BlobError;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_protocol::ThreadId;

use crate::error::Blocked;
use crate::framework::ItemContext;

/// `MAX_ATTACHMENT_BLOB_BYTES` (`v145:src/runtime/attachments/limits.mjs:9`).
const MAX_ATTACHMENT_BLOB_BYTES: u64 = 64 * 1024 * 1024;

/// Node's office extractor (`tryExtractOoxmlTextFromBuffer` with the lowering limits) as the
/// composition supplies it: the extension host's [`DocumentText`] (`ExtDocumentText`), called
/// on `runtime` from the migration's own thread, which is outside every async context.
#[derive(Clone)]
pub struct OfficeExtractor {
    pub docs: Arc<dyn DocumentText>,
    pub runtime: tokio::runtime::Handle,
}

impl OfficeExtractor {
    /// `DocumentText::office_text` of `bytes` (sent base64, as a message part carries them).
    fn text(&self, thread: &ThreadId, bytes: &[u8], filename: &str) -> Result<Option<String>, Blocked> {
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.runtime
            .block_on(self.docs.office_text(thread, filename, &data))
            .map_err(|e| Blocked::Extractor { detail: format!("office text of {filename}: {e:?}") })
    }
}

/// The attachment store and the extractor of one session's migration.
pub struct ContextBlobs<'a, 'b> {
    pub cx: &'a ItemContext<'b>,
    pub office: &'a OfficeExtractor,
    /// The session: the extractor's fairness key.
    pub thread: ThreadId,
}

impl AttachmentBytes for ContextBlobs<'_, '_> {
    type Error = Blocked;

    /// `readAttachmentBuffer` (`v145:src/runtime/attachments/store.mjs:263-292`): a missing
    /// blob, one that is not a regular file of 1 byte to `MAX_ATTACHMENT_BLOB_BYTES`, and one
    /// whose sha256 is not its name are permanent (`isPermanentAttachmentError`); any other
    /// failure blocks the run.
    fn bytes(&self, reference: &str) -> Result<Vec<u8>, BlobError<Blocked>> {
        let path = self.cx.blob_path(reference);
        match crate::durable::read_within(&path, MAX_ATTACHMENT_BLOB_BYTES) {
            Ok(Some(bytes)) if crate::durable::sha256_hex(&bytes) == reference => Ok(bytes),
            Ok(_) => Err(BlobError::Permanent),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidData) => {
                Err(BlobError::Permanent)
            }
            Err(e) => Err(BlobError::Transient(Blocked::io("read", &path, e))),
        }
    }

    fn office_text(&self, bytes: &[u8], filename: &str) -> Result<Option<String>, Blocked> {
        self.office.text(&self.thread, bytes, filename)
    }
}

/// An extractor over a recording [`DocumentText`], for the crate's tests.
#[cfg(test)]
pub(crate) mod testing {
    use std::sync::LazyLock;
    use std::sync::Mutex;

    use mixdog_core_api::domain::ext::ExtError;
    use mixdog_core_api::domain::ext::PdfIntake;

    use super::*;

    static RUNTIME: LazyLock<tokio::runtime::Runtime> =
        LazyLock::new(|| tokio::runtime::Builder::new_current_thread().build().expect("a test runtime"));

    /// Answers `text of <filename>`, or fails for `broken.docx`; records `(thread, filename, data)`.
    #[derive(Default)]
    pub(crate) struct Docs(pub Mutex<Vec<(String, String, String)>>);

    #[async_trait::async_trait]
    impl DocumentText for Docs {
        async fn office_text(&self, thread: &ThreadId, filename: &str, data: &str) -> Result<Option<String>, ExtError> {
            self.0.lock().unwrap().push((thread.to_string(), filename.to_owned(), data.to_owned()));
            if filename == "broken.docx" { Err(ExtError::Overloaded) } else { Ok(Some(format!("text of {filename}"))) }
        }
        async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
            unreachable!("the migration extracts no PDF text")
        }
        async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
            unreachable!("the migration counts no PDF")
        }
    }

    pub(crate) fn office(docs: Arc<Docs>) -> OfficeExtractor {
        OfficeExtractor { docs, runtime: RUNTIME.handle().clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    #[test]
    fn office_documents_are_extracted_by_the_host_from_their_bytes() {
        let docs = Arc::new(Docs::default());
        let office = office(docs.clone());
        let thread = ThreadId::from("sess_a".to_owned());
        assert_eq!(office.text(&thread, b"PK\x03\x04", "a.docx").unwrap(), Some("text of a.docx".to_owned()));
        assert_eq!(*docs.0.lock().unwrap(), [("sess_a".to_owned(), "a.docx".to_owned(), "UEsDBA==".to_owned())]);
        // A host failure is the machine's, not the document's: the run blocks.
        assert!(matches!(office.text(&thread, b"x", "broken.docx"), Err(Blocked::Extractor { .. })));
    }
}
