//! The host side of stored text attachments in a request (`attachmentTextForPart`,
//! attachments/store.mjs:457): the blob's bytes read from the store on the interactive lane, then
//! the model-facing text from [`attachment_text`].

use async_trait::async_trait;
use mixdog_agent::attachments::AttachmentText;
use mixdog_ai::service::model_proxy_inline::AttachmentReader;
use mixdog_ai::service::model_proxy_inline::ReadError;
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_protocol::message_class::user_text::attachment_text;

use crate::domains::ai_admin::model_proxy::StoreAttachments;

#[async_trait]
impl AttachmentText for StoreAttachments {
    async fn media_of(&self, part: &ContentPart, native_pdf: bool) -> Result<Option<ContentPart>, Box<ProviderError>> {
        self.media_part(part, native_pdf).await
    }

    async fn text_of(&self, part: &ContentPart) -> Result<Option<String>, Box<ProviderError>> {
        let ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type, filename, text: Some(text) } = part
        else {
            return Ok(None);
        };
        match self.read(reference).await {
            Ok(bytes) => Ok(Some(attachment_text(&String::from_utf8_lossy(&bytes), text.kind.as_deref(), filename.as_deref()))),
            // A blob that is gone or corrupt will never be readable: it lowers to its stand-in
            // (`unavailableAttachmentText`, media-normalization.mjs:438). Anything else may pass.
            Err(ReadError::Permanent) => Ok(Some(unavailable(filename.as_deref(), mime_type))),
            Err(ReadError::Other(message)) => {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.message = message;
                Err(Box::new(error))
            }
        }
    }
}

fn unavailable(filename: Option<&str>, mime_type: &str) -> String {
    unavailable_of(filename, mime_type, "text")
}

fn unavailable_of(filename: Option<&str>, mime_type: &str, kind: &str) -> String {
    let name = filename.and_then(|f| f.rsplit(['/', '\\']).next()).unwrap_or("");
    let label = [name, mime_type, kind].into_iter().find(|v| !v.is_empty()).unwrap_or(kind);
    format!("[attachment unavailable: {label}]")
}

impl StoreAttachments {
    /// `readAttachmentBase64` and the lowering of a part whose blob it cannot read
    /// (media-normalization.mjs `imageInfo`, `fileInfo`, `unavailableAttachmentText`).
    async fn media_part(&self, part: &ContentPart, native_pdf: bool) -> Result<Option<ContentPart>, Box<ProviderError>> {
        use base64::Engine;
        use mixdog_core_api::domain::provider::ImageSource;
        let ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type, filename, text: None } = part else {
            return Ok(None);
        };
        let label = mime_type.trim().to_lowercase();
        let image = label.starts_with("image/");
        let bytes = match self.read(reference).await {
            Ok(bytes) => bytes,
            Err(ReadError::Permanent) => {
                return Ok(Some(ContentPart::Text(unavailable_of(filename.as_deref(), mime_type, if image { "image" } else { "file" }), None)));
            }
            Err(ReadError::Other(message)) => {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.message = message;
                return Err(Box::new(error));
            }
        };
        if image {
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            return Ok(Some(ContentPart::Image(ImageSource::Base64 { data, mime_type: label })));
        }
        // The bytes decide a PDF before the label does (`bytesDecideMime`); a file without a type is a PDF.
        let pdf = bytes.starts_with(b"%PDF-");
        let mime = if pdf || label.is_empty() { "application/pdf".to_owned() } else { label };
        if mime == "application/pdf" && !native_pdf {
            return Ok(None);
        }
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(Some(ContentPart::File { source: BinarySource::Base64(data), mime_type: mime, filename: filename.clone(), text: None }))
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::TextAttachment;
    use tokio_util::sync::CancellationToken;

    use super::*;

    async fn stored(text: &str) -> (tempfile::TempDir, StoreAttachments, String) {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let store = mixdog_store::blobs::BlobStore::new(dir.path());
        let put = text.as_bytes().to_vec();
        let writer = store.clone();
        let digest = mixdog_core_base::support::on_lane(tokens.durability_io, &CancellationToken::new(), move |lane| {
            writer.put(lane, &put).map(|pin| pin.digest().as_str().to_owned())
        })
        .await
        .unwrap()
        .unwrap();
        let hex = digest.strip_prefix("sha256:").unwrap().to_owned();
        (dir, StoreAttachments { store, interactive: tokens.interactive_io }, hex)
    }

    fn part(reference: String, kind: Option<&str>, filename: Option<&str>) -> ContentPart {
        ContentPart::File {
            source: BinarySource::AttachmentRef(reference),
            mime_type: String::new(),
            filename: filename.map(str::to_owned),
            text: Some(TextAttachment { kind: kind.map(str::to_owned) }),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stored_text_parts_read_as_nodes_attachment_text() {
        let twin: serde_json::Value =
            serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/ai-admin/model-proxy-twin.json")).unwrap();
        let cases = twin["textCases"].as_array().unwrap();
        assert_eq!(cases.len(), 36);
        for case in cases {
            let (_dir, store, reference) = stored(case["text"].as_str().unwrap()).await;
            let got = store.text_of(&part(reference, case["textKind"].as_str(), case["filename"].as_str())).await.unwrap();
            assert_eq!(got.as_deref(), case["value"].as_str(), "{case}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stored_media_reads_as_the_bytes_every_provider_is_sent() {
        use base64::Engine;
        use mixdog_core_api::domain::provider::ImageSource;
        let b64 = |t: &str| base64::engine::general_purpose::STANDARD.encode(t);
        let file = |reference: String, mime: &str, name: &str| ContentPart::File {
            source: BinarySource::AttachmentRef(reference),
            mime_type: mime.to_owned(),
            filename: Some(name.to_owned()),
            text: None,
        };
        let (_dir, store, png) = stored("png-bytes").await;
        let image = store.media_of(&file(png.clone(), "IMAGE/PNG", "a.png"), true).await.unwrap();
        assert_eq!(image, Some(ContentPart::Image(ImageSource::Base64 { data: b64("png-bytes"), mime_type: "image/png".into() })));
        let (_dir, store, pdf) = stored("%PDF-1.4 x").await;
        let mislabelled = store.media_of(&file(pdf.clone(), "application/octet-stream", "a.pdf"), true).await.unwrap();
        assert_eq!(
            mislabelled,
            Some(ContentPart::File { source: BinarySource::Base64(b64("%PDF-1.4 x")), mime_type: "application/pdf".into(), filename: Some("a.pdf".into()), text: None })
        );
        assert_eq!(store.media_of(&file(pdf, "application/pdf", "a.pdf"), false).await.unwrap(), None, "a PDF for a text provider is left to its text step");
        let gone = store.media_of(&file("0".repeat(64), "image/png", "C:\\d\\gone.png"), true).await.unwrap();
        assert_eq!(gone, Some(ContentPart::Text("[attachment unavailable: gone.png]".into(), None)));
        assert!(store.media_of(&file("bad".into(), "image/png", "x"), true).await.is_err(), "a transient failure is an error");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_gone_blob_reads_as_its_stand_in_and_other_parts_are_left_alone() {
        let (_dir, store, _) = stored("x").await;
        let gone = store.text_of(&part("0".repeat(64), Some("file"), Some("C:\\docs\\notes.md"))).await.unwrap();
        assert_eq!(gone.as_deref(), Some("[attachment unavailable: notes.md]"));
        let not_text = ContentPart::File {
            source: BinarySource::AttachmentRef("0".repeat(64)),
            mime_type: "application/pdf".into(),
            filename: None,
            text: None,
        };
        assert_eq!(store.text_of(&not_text).await.unwrap(), None);
        assert!(store.text_of(&part("not-a-digest".into(), None, None)).await.is_err());
    }
}
