//! `inlineModelProxyAttachments` (model-proxy-provider.mjs:61): a stored attachment reference names
//! a blob in the sending core's store, which the PC running the call cannot read, so each one
//! travels as the bytes it was stored from. Newer messages are inlined first and the whole call
//! shares one byte budget; a reference past the budget stays a reference, which the PC lowers to
//! its "unavailable" text.

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::provider::{BinarySource, Content, ContentPart, Message};

/// The store's own single-blob ceiling (`MAX_ATTACHMENT_BLOB_BYTES`, attachments/limits.mjs:9).
pub const MODEL_PROXY_INLINE_MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum ReadError {
    /// Missing, invalid or failing its digest: the blob will never be readable (`isPermanentAttachmentError`).
    Permanent,
    Other(String),
}

/// The sending core's attachment store: bytes by the reference's 64 hex digits. The store-side
/// implementation reads mixdog_store::blobs::BlobStore on the interactive lane (the protocol's
/// Blobs reads text only).
#[async_trait]
pub trait AttachmentReader: Send + Sync {
    async fn read(&self, reference: &str) -> Result<Vec<u8>, ReadError>;
}

/// `messages` with every readable stored reference replaced by its bytes.
pub async fn inline_attachments(messages: &mut [Message], reader: &dyn AttachmentReader, max_bytes: usize) -> Result<(), String> {
    let mut remaining = max_bytes;
    for message in messages.iter_mut().rev() {
        let Content::Parts(parts) = &mut message.content else { continue };
        for part in parts.iter_mut().rev() {
            let ContentPart::File { source, .. } = part else { continue };
            let BinarySource::AttachmentRef(reference) = source else { continue };
            let bytes = match reader.read(reference).await {
                Ok(bytes) => bytes,
                Err(ReadError::Permanent) => continue,
                Err(ReadError::Other(e)) => return Err(e),
            };
            if bytes.len() > remaining {
                continue;
            }
            remaining -= bytes.len();
            *source = BinarySource::Base64(STANDARD.encode(bytes));
        }
    }
    Ok(())
}
