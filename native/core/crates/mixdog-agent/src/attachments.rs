//! Stored text attachments in a request. A saved message holds a text attachment as a
//! reference (`{type:'text', attachmentRef, …}`, a `File` part with an `AttachmentRef` source
//! here); the bytes live in the blob store. Providers lower the reference to its text when the
//! request is built (`attachmentTextForPart` in `media-normalization.mjs:505,1022`), on every
//! request, without rewriting the saved message. This does the same step before the provider
//! sees the request.
//!
//! The text itself (`<file name="…">…</file>` for a file, the paste as written, the
//! `[attachment unavailable: …]` stand-in for a blob that is gone) is the attachment layer's;
//! the host reads the bytes through the core's lane and answers through [`AttachmentText`].

use async_trait::async_trait;
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ProviderError;

#[async_trait]
pub trait AttachmentText: Send + Sync {
    /// The text a stored text-attachment reference stands for in a request, or `None` when
    /// the part is not a text reference (an image or document reference stays as it is). A
    /// transient read failure is an error; a blob that is permanently gone reads as its
    /// unavailable text. Cancel-safe.
    async fn text_of(&self, part: &ContentPart) -> Result<Option<String>, Box<ProviderError>>;
}

fn is_reference(part: &ContentPart) -> bool {
    matches!(part, ContentPart::File { source: BinarySource::AttachmentRef(_), text: Some(_), .. })
}

/// The messages with every text-attachment reference replaced, in place, by its text part.
pub async fn resolve_text_attachments(
    mut messages: Vec<Message>,
    resolver: &dyn AttachmentText,
) -> Result<Vec<Message>, Box<ProviderError>> {
    for message in &mut messages {
        let Content::Parts(parts) = &mut message.content else { continue };
        for part in parts.iter_mut().filter(|p| is_reference(p)) {
            if let Some(text) = resolver.text_of(part).await? {
                *part = ContentPart::Text(text, None);
            }
        }
    }
    Ok(messages)
}
