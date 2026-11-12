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

    /// The part a stored image or file reference stands for in a request: the bytes it names
    /// (`readAttachmentBase64`, what every provider's media normalization sends), or the
    /// unavailable-attachment text for a blob that is permanently gone. `None` leaves the part as
    /// it is (not a media reference, a PDF for a provider that takes PDFs as text, or a host
    /// that cannot read the store). A transient read failure is an error. Cancel-safe.
    async fn media_of(&self, part: &ContentPart, native_pdf: bool) -> Result<Option<ContentPart>, Box<ProviderError>> {
        let _ = (part, native_pdf);
        Ok(None)
    }
}

fn is_reference(part: &ContentPart) -> bool {
    matches!(part, ContentPart::File { source: BinarySource::AttachmentRef(_), text: Some(_), .. })
}

/// The messages with every stored image or file reference replaced, in place, by what
/// [`AttachmentText::media_of`] answers for it.
pub async fn resolve_media_attachments(
    mut messages: Vec<Message>,
    resolver: &dyn AttachmentText,
    native_pdf: bool,
) -> Result<Vec<Message>, Box<ProviderError>> {
    for message in &mut messages {
        let Content::Parts(parts) = &mut message.content else { continue };
        for part in parts.iter_mut() {
            if matches!(part, ContentPart::File { source: BinarySource::AttachmentRef(_), text: None, .. })
                && let Some(resolved) = resolver.media_of(part, native_pdf).await?
            {
                *part = resolved;
            }
        }
    }
    Ok(messages)
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
