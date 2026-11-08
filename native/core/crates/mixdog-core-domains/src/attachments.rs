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
    let name = filename.and_then(|f| f.rsplit(['/', '\\']).next()).unwrap_or("");
    let label = [name, mime_type, "text"].into_iter().find(|v| !v.is_empty()).unwrap_or("text");
    format!("[attachment unavailable: {label}]")
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
            serde_json::from_str(include_str!("../../../fixtures/ai-admin/model-proxy-twin.json")).unwrap();
        let cases = twin["textCases"].as_array().unwrap();
        assert_eq!(cases.len(), 36);
        for case in cases {
            let (_dir, store, reference) = stored(case["text"].as_str().unwrap()).await;
            let got = store.text_of(&part(reference, case["textKind"].as_str(), case["filename"].as_str())).await.unwrap();
            assert_eq!(got.as_deref(), case["value"].as_str(), "{case}");
        }
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
