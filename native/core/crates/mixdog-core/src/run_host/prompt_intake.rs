//! A turn submission's PDF intake (`session-turns.mjs:112` `submitAdmitted` ->
//! `preparePromptSubmissionForProvider`, `attachments/store.mjs:784`): every PDF file part of the prompt, inline or
//! stored, is measured before the message is accepted. One over 20 MiB (`store.mjs:801`), one the parser rejects, and,
//! for a route that sends PDFs natively, one over 100 pages (`store.mjs:810`) refuse the submit with Node's text.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_ai::service::model_proxy_inline::{AttachmentReader, ReadError};
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_session::session::PromptIntake;
use mixdog_protocol::ThreadId;
use serde_json::Value;

use super::media::pdf_intake_facts;

/// The intake over the attachment store, the document inspector and the routes' PDF traits.
pub struct PdfPromptIntake {
    pub reader: Arc<dyn AttachmentReader>,
    pub docs: Arc<dyn DocumentText>,
    /// `providerNativePdf(provider)`.
    pub native_pdf: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

#[async_trait]
impl PromptIntake for PdfPromptIntake {
    async fn admit(&self, thread: &ThreadId, provider: &str, params: &Value) -> Result<(), String> {
        let Some(parts) = params.pointer("/input/prompt").and_then(Value::as_array) else { return Ok(()) };
        let native = (self.native_pdf)(provider);
        for part in parts {
            let is_pdf = part.get("type").and_then(Value::as_str) == Some("file")
                && part
                    .get("mimeType")
                    .or_else(|| part.get("mediaType"))
                    .and_then(Value::as_str)
                    .is_some_and(|mime| mime.eq_ignore_ascii_case("application/pdf"));
            if !is_pdf {
                continue;
            }
            // `materializePromptSubmission` stores an inline payload first; the size is the stored blob's.
            let bytes = match (part.get("data").and_then(Value::as_str), part.get("attachmentRef").and_then(Value::as_str)) {
                (Some(data), _) => STANDARD.decode(data).map_err(|error| error.to_string())?,
                (None, Some(reference)) => match self.reader.read(reference).await {
                    Ok(bytes) => bytes,
                    Err(ReadError::Permanent) => return Err(format!("attachment {reference} is missing")),
                    Err(ReadError::Other(message)) => return Err(message),
                },
                (None, None) => continue,
            };
            pdf_intake_facts(&*self.docs, thread, &STANDARD.encode(&bytes), bytes.len() as u64, native).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {}
