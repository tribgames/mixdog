//! Requests for a model that takes no media input (`input-capabilities.mjs`
//! with `degradeMediaParts` of `media-normalization.mjs`).
//!
//! The managed local model is text-only: every media part anywhere in the
//! request becomes fixed text (images to a placeholder, a file or document to
//! its text form), the stored transcript is never touched, and only a current
//! user turn left with nothing but omitted placeholders is an error. The text
//! form of a file (decoded text, extracted Office text, the "not sent inline"
//! description, the unavailable-attachment placeholder) is the media layer's:
//! the seam [`MediaText`].

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;

/// The media layer behind the text-only check.
#[async_trait]
pub trait MediaText: Send + Sync {
    /// `preparePdfTextForProvider`: the messages with every PDF part replaced
    /// by its `--- label ---\n<text>` text part. Awaited on every attempt
    /// before the request is checked; the same messages when there is nothing
    /// to convert. Cancel-safe.
    async fn prepare_pdf_text(&self, messages: Vec<Message>) -> Result<Vec<Message>, Box<ProviderError>>;

    /// `textFormOfFilePart` for a `File` or `Document` part: the text every
    /// provider's lowering produces for it, the unavailable-attachment
    /// placeholder for a reference that is permanently gone, `None` when the
    /// part has no readable bytes (a document with a text or content source).
    /// A PDF reaching this unprepared, or a transient read error, is an error.
    fn text_form(&self, part: &ContentPart) -> Result<Option<String>, Box<ProviderError>>;
}

/// The model facts the check reads.
#[derive(Clone, Debug)]
pub struct TextOnlyModel {
    /// The catalog entry's name.
    pub name: String,
    /// `runtimeCapabilities.tools ?? model.supportsFunctionCalling`: the
    /// host resolves it once the model server's capabilities are known.
    pub supports_tools: Option<bool>,
}

/// A route whose model takes no media input.
#[derive(Clone)]
pub struct TextOnlyInput {
    pub model: TextOnlyModel,
    pub media: Arc<dyn MediaText>,
}

fn rejected(message: String) -> Box<ProviderError> {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.message = message;
    Box::new(error)
}

/// JavaScript's `String.prototype.trim`: Rust additionally trims U+0085 and
/// not U+FEFF.
pub(crate) fn js_trim(text: &str) -> &str {
    mixdog_js::js_trim(text)
}

/// The fixed text that stands for a media part the model cannot take.
pub fn omitted_media_text(label: &str) -> String {
    format!("[{label} omitted: local model is text-only]")
}

/// Whether a lowered text only says that media was left out
/// (`isUnsentMediaText`): the omitted placeholder, or a file's "not sent
/// inline" description.
pub fn is_unsent_media_text(text: &str) -> bool {
    let omitted = text
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(" omitted: local model is text-only]"))
        .is_some_and(|label| !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    omitted || text.starts_with("[file not sent inline:")
}

/// `degradeMediaParts`: the parts with every media part replaced by its text,
/// `None` when nothing changed. (The Rust content model has no nested content
/// and no audio or video parts.)
pub fn degrade_media_parts(
    parts: &[ContentPart],
    media: &dyn MediaText,
) -> Result<Option<Vec<ContentPart>>, Box<ProviderError>> {
    let mut changed = false;
    let mut next = Vec::with_capacity(parts.len());
    for part in parts {
        let text = match part {
            ContentPart::Text(_, _) => None,
            ContentPart::Image(_) => Some(omitted_media_text("image")),
            ContentPart::File { .. } => Some(media.text_form(part)?.unwrap_or_else(|| omitted_media_text("file"))),
            ContentPart::Document { .. } => {
                Some(media.text_form(part)?.unwrap_or_else(|| omitted_media_text("document")))
            }
        };
        match text {
            Some(text) => {
                changed = true;
                next.push(ContentPart::Text(text, None));
            }
            None => next.push(part.clone()),
        }
    }
    Ok(changed.then_some(next))
}

fn has_text(parts: &[ContentPart]) -> bool {
    parts.iter().any(|p| matches!(p, ContentPart::Text(t, _) if !js_trim(t).is_empty()))
}

fn has_usable_text(part: &ContentPart) -> bool {
    matches!(part, ContentPart::Text(t, _) if !js_trim(t).is_empty() && !is_unsent_media_text(t))
}

/// `assertLocalModelInput`: validates the request for a text-only model and
/// returns the messages to send. `tools` is whether the request offers any
/// tool; `effort` whether it carries a reasoning-level setting.
pub fn assert_text_only_input(
    model: &TextOnlyModel,
    media: &dyn MediaText,
    messages: Vec<Message>,
    tools: bool,
    effort: bool,
) -> Result<Vec<Message>, Box<ProviderError>> {
    if let Some(current) = messages.iter().rev().find(|m| m.role == Role::User)
        && let Content::Parts(parts) = &current.content
        && !has_text(parts)
    {
        // Media with a text form (a PDF, an Office file) is usable input; only
        // a turn left with nothing but omitted placeholders is an error.
        if let Some(converted) = degrade_media_parts(parts, media)?
            && !converted.iter().any(has_usable_text)
        {
            return Err(rejected(format!(
                "[local-provider] {} is text-only in this managed runtime. Use a compatible multimodal provider for image, audio, video or document input.",
                model.name
            )));
        }
    }
    let mut degraded = Vec::with_capacity(messages.len());
    for mut message in messages {
        if let Content::Parts(parts) = &message.content
            && let Some(content) = degrade_media_parts(parts, media)?
        {
            message.content = Content::Parts(content);
        }
        degraded.push(message);
    }
    if tools && model.supports_tools == Some(false) {
        return Err(rejected(format!(
            "[local-provider] {} does not support the requested tool interface. Choose a tool-capable model.",
            model.name
        )));
    }
    if effort {
        return Err(rejected(
            "[local-provider] reasoning-level controls are not configured for this model; remove the setting or choose another provider."
                .to_owned(),
        ));
    }
    Ok(degraded)
}

/// The request as a text-only model receives it: PDFs prepared, media
/// degraded. A rejected request is a deterministic, unsent failure.
pub async fn prepare_text_only_request(
    text_only: &TextOnlyInput,
    mut request: ModelRequest,
) -> Result<ModelRequest, Box<ProviderError>> {
    let prepared = text_only.media.prepare_pdf_text(std::mem::take(&mut request.messages)).await?;
    let effort = request.options.effort.as_deref().is_some_and(|e| !e.is_empty());
    request.messages = assert_text_only_input(
        &text_only.model,
        text_only.media.as_ref(),
        prepared,
        !request.tools.is_empty(),
        effort,
    )?;
    Ok(request)
}
