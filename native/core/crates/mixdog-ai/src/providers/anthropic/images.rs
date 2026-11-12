//! The Messages wire's image preparation (`prepareAnthropicImages`, `lib/anthropic-image-input.mjs`), run on every
//! request a Messages engine sends (the API-key and subscription routes, the gateways' and custom Messages engines,
//! Claude on Vertex AI): each inline image is fitted by `resizeImageBuffer` under the `anthropic` profile (the extension
//! host's `sharp`, so the bytes are Node's), a resized one is announced by a text part ahead of it, and an image that
//! cannot be prepared fails the request before anything is sent.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::ext::ImageProfile;
use mixdog_core_api::domain::ext::ProfiledImageResizer;
use mixdog_core_api::domain::ext::ProfiledResizeError;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_protocol::ThreadId;

/// `MAX_INPUT_BASE64_SIZE`: 64 MiB of bytes as base64.
const MAX_INPUT_BASE64: usize = (64 * 1024 * 1024_usize).div_ceil(3) * 4;
/// `API_IMAGE_MAX_BASE64_SIZE`.
const API_IMAGE_MAX_BASE64: usize = 5 * 1024 * 1024;
/// `IMAGE_MAX_WIDTH` and `IMAGE_MAX_HEIGHT`.
const MAX_EDGE: u32 = 1568;

/// `AnthropicImagePreparationError.code`; the agent's image-strip recovery reads it (`isInvalidImageCode`).
pub const PREPARATION_FAILED: &str = "ANTHROPIC_IMAGE_PREPARATION_FAILED";
/// `AnthropicImageRuntimeError.code`: the machine cannot resize, which says nothing of the image.
pub const RUNTIME_UNAVAILABLE: &str = "ANTHROPIC_IMAGE_RUNTIME_UNAVAILABLE";

/// `supersedingImageMetadataText(dims)` of an image whose display size differs from its original.
pub fn superseding_metadata_text(original: (u32, u32), display: (u32, u32)) -> String {
    let scale = mixdog_js::math::to_fixed(f64::from(original.0) / f64::from(display.0), 2);
    format!(
        "[Image: {}x{}, displayed at {}x{}. Multiply coordinates by {scale} to map to the original image.] \
         These display dimensions supersede any earlier display-size annotation for the following image.",
        original.0, original.1, display.0, display.1
    )
}

fn local_400(code: &str, message: String) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.status = Some(400);
    error.code = Some(code.to_owned());
    error.message = message;
    error
}

fn preparation_failed(path: &str, detail: &str) -> ProviderError {
    local_400(
        PREPARATION_FAILED,
        format!("Anthropic image preparation failed at {path}: {detail}. The original image and conversation were not changed."),
    )
}

fn runtime_unavailable(path: &str) -> ProviderError {
    local_400(
        RUNTIME_UNAVAILABLE,
        format!(
            "Anthropic image preparation unavailable at {path}: image resizing is unavailable; repair the sharp runtime. \
             The original image and conversation were not changed."
        ),
    )
}

/// The parts that replace one image part: its annotation, when its display size changed, and the image; `None` when
/// the image is already as it should be sent.
async fn prepared(
    resizer: &dyn ProfiledImageResizer,
    thread: &ThreadId,
    path: &str,
    data: &str,
    mime: &str,
) -> Result<Option<Vec<ContentPart>>, ProviderError> {
    if data.is_empty() || data.len() > MAX_INPUT_BASE64 {
        return Err(preparation_failed(path, "image is empty or exceeds the 64 MiB input limit; use a smaller image"));
    }
    let undecodable = || preparation_failed(path, "image could not be decoded; reattach a valid image");
    let bytes = STANDARD.decode(data).map_err(|_| undecodable())?;
    let declared = if mime.is_empty() { "image/png" } else { mime };
    let resized = match resizer.resize_profiled(thread, &bytes, declared.split('/').nth(1).unwrap_or_default(), ImageProfile::Anthropic).await {
        Ok(Some(resized)) => resized,
        Ok(None) | Err(ProfiledResizeError::Host(_)) => return Err(runtime_unavailable(path)),
        Err(ProfiledResizeError::Invalid(_)) => return Err(undecodable()),
    };
    if resized.display_w == 0
        || resized.display_h == 0
        || resized.display_w > MAX_EDGE
        || resized.display_h > MAX_EDGE
        || resized.data_base64.len() > API_IMAGE_MAX_BASE64
    {
        return Err(preparation_failed(path, "image still exceeds the supported size; use a smaller image"));
    }
    if resized.data_base64 == data && resized.mime == mime {
        return Ok(None);
    }
    let mut parts = Vec::new();
    if (resized.original_w, resized.original_h) != (resized.display_w, resized.display_h) {
        parts.push(ContentPart::Text(
            superseding_metadata_text((resized.original_w, resized.original_h), (resized.display_w, resized.display_h)),
            None,
        ));
    }
    parts.push(ContentPart::Image(ImageSource::Base64 { data: resized.data_base64, mime_type: resized.mime }));
    Ok(Some(parts))
}

/// The request with every inline image prepared, or the request itself when there is none to change.
pub async fn prepare_request(request: Arc<ModelRequest>, resizer: &dyn ProfiledImageResizer) -> Result<Arc<ModelRequest>, ProviderError> {
    let thread = ThreadId::from(request.options.session_id.clone().unwrap_or_default());
    let mut next: Option<ModelRequest> = None;
    for (index, message) in request.messages.iter().enumerate() {
        let Content::Parts(parts) = &message.content else { continue };
        let mut out = Vec::with_capacity(parts.len());
        let mut changed = false;
        for (at, part) in parts.iter().enumerate() {
            let ContentPart::Image(ImageSource::Base64 { data, mime_type }) = part else {
                out.push(part.clone());
                continue;
            };
            match prepared(resizer, &thread, &format!("messages.{index}.content.{at}"), data, mime_type).await? {
                Some(replacement) => {
                    changed = true;
                    out.extend(replacement);
                }
                None => out.push(part.clone()),
            }
        }
        if changed {
            next.get_or_insert_with(|| (*request).clone()).messages[index].content = Content::Parts(out);
        }
    }
    Ok(next.map_or(request, Arc::new))
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::ext::ExtError;
    use mixdog_core_api::domain::ext::ResizedImage;
    use mixdog_core_api::domain::provider::Message;
    use mixdog_core_api::domain::provider::RequestOptions;
    use mixdog_core_api::domain::provider::Role;

    use super::*;

    /// A resizer that answers what it is told for every image.
    struct Answer(Result<Option<ResizedImage>, ProfiledResizeError>);

    #[async_trait::async_trait]
    impl ProfiledImageResizer for Answer {
        async fn resize_profiled(&self, _: &ThreadId, _: &[u8], _: &str, profile: ImageProfile) -> Result<Option<ResizedImage>, ProfiledResizeError> {
            assert_eq!(profile, ImageProfile::Anthropic);
            self.0.clone()
        }
    }

    fn resized(data: &str, mime: &str, original: (u32, u32), display: (u32, u32)) -> ResizedImage {
        ResizedImage { data_base64: data.into(), mime: mime.into(), original_w: original.0, original_h: original.1, display_w: display.0, display_h: display.1 }
    }

    fn request(data: &str) -> Arc<ModelRequest> {
        let content = Content::Parts(vec![
            ContentPart::Text("look".into(), None),
            ContentPart::Image(ImageSource::Base64 { data: data.into(), mime_type: "image/png".into() }),
        ]);
        Arc::new(ModelRequest { model: "m".into(), messages: vec![Message::new(Role::User, content)], tools: Vec::new(), options: RequestOptions::default() })
    }

    async fn prepared(answer: Result<Option<ResizedImage>, ProfiledResizeError>, data: &str) -> Result<Arc<ModelRequest>, ProviderError> {
        prepare_request(request(data), &Answer(answer)).await
    }

    fn parts(request: &ModelRequest) -> &[ContentPart] {
        let Content::Parts(parts) = &request.messages[0].content else { panic!("parts") };
        parts
    }

    /// A resized image is announced by a text part ahead of it and carries the resized bytes; one the resizer leaves as
    /// it is stays the same request.
    #[tokio::test]
    async fn a_resized_image_is_announced_and_an_unchanged_one_is_left_alone() {
        let got = prepared(Ok(Some(resized("QkJC", "image/png", (1, 1), (200, 200)))), "QUFB").await.unwrap();
        assert_eq!(
            parts(&got)[1..],
            [
                ContentPart::Text(superseding_metadata_text((1, 1), (200, 200)), None),
                ContentPart::Image(ImageSource::Base64 { data: "QkJC".into(), mime_type: "image/png".into() }),
            ]
        );
        assert!(superseding_metadata_text((1, 1), (200, 200)).starts_with("[Image: 1x1, displayed at 200x200. Multiply coordinates by 0.01 to map"));
        // The same bytes and format, in range: the request is the one it was given.
        let same = request("QUFB");
        let got = prepare_request(same.clone(), &Answer(Ok(Some(resized("QUFB", "image/png", (640, 480), (640, 480)))))).await.unwrap();
        assert!(Arc::ptr_eq(&got, &same));
        // The same bytes under another format name are a change without an annotation.
        let got = prepared(Ok(Some(resized("QUFB", "image/jpeg", (640, 480), (640, 480)))), "QUFB").await.unwrap();
        assert_eq!(parts(&got).len(), 2);
        assert_eq!(parts(&got)[1], ContentPart::Image(ImageSource::Base64 { data: "QUFB".into(), mime_type: "image/jpeg".into() }));
    }

    /// An image that cannot be prepared fails the request before it is sent: a decoder's rejection or an image that is
    /// still too large is Node's preparation error, a machine that cannot resize is the runtime error (no strip).
    #[tokio::test]
    async fn an_image_that_cannot_be_prepared_is_refused_with_nodes_error() {
        let refused = |error: ProviderError, code: &str, text: &str| {
            assert_eq!((error.status, error.code.as_deref(), error.kind), (Some(400), Some(code), ErrorKind::InvalidRequest));
            assert_eq!(error.message, text);
        };
        let undecodable = prepared(Err(ProfiledResizeError::Invalid("bad".into())), "QUFB").await.unwrap_err();
        refused(
            undecodable,
            PREPARATION_FAILED,
            "Anthropic image preparation failed at messages.0.content.1: image could not be decoded; reattach a valid image. The original image and conversation were not changed.",
        );
        let too_big = prepared(Ok(Some(resized("QkJC", "image/png", (3000, 100), (1569, 52)))), "QUFB").await.unwrap_err();
        refused(
            too_big,
            PREPARATION_FAILED,
            "Anthropic image preparation failed at messages.0.content.1: image still exceeds the supported size; use a smaller image. The original image and conversation were not changed.",
        );
        let over_cap = prepared(Ok(Some(resized(&"A".repeat(API_IMAGE_MAX_BASE64 + 1), "image/jpeg", (10, 10), (200, 200)))), "QUFB").await.unwrap_err();
        assert_eq!(over_cap.code.as_deref(), Some(PREPARATION_FAILED));
        let empty = prepared(Ok(None), "").await.unwrap_err();
        assert_eq!(empty.code.as_deref(), Some(PREPARATION_FAILED));
        let down = "Anthropic image preparation unavailable at messages.0.content.1: image resizing is unavailable; repair the sharp runtime. The original image and conversation were not changed.";
        refused(prepared(Ok(None), "QUFB").await.unwrap_err(), RUNTIME_UNAVAILABLE, down);
        refused(prepared(Err(ProfiledResizeError::Host(ExtError::Overloaded)), "QUFB").await.unwrap_err(), RUNTIME_UNAVAILABLE, down);
    }
}
