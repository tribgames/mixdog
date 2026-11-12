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
                && part.get("mimeType").or_else(|| part.get("mediaType")).and_then(Value::as_str).is_some_and(|mime| mime.eq_ignore_ascii_case("application/pdf"));
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
mod tests {
    use super::*;
    use mixdog_core_api::domain::ext::{ExtError, PdfCounts, PdfIntake};

    /// The inspector's answer for each recorded PDF, by its bytes: what Node's `inspectPdfBuffer` answered there
    /// (the counts of an accepted one, the parser's message of a rejected one, 101 pages for the 101-page one).
    struct Inspected(Vec<(Vec<u8>, Result<PdfCounts, String>)>);
    #[async_trait]
    impl DocumentText for Inspected {
        async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, ExtError> {
            unreachable!("no Office file")
        }
        async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
            unreachable!("the intake extracts no text")
        }
        async fn pdf_counts(&self, _: &ThreadId, data: &str) -> Result<PdfIntake, ExtError> {
            let bytes = STANDARD.decode(data).unwrap();
            let (_, answer) = self.0.iter().find(|(b, _)| *b == bytes).expect("an inspected PDF");
            Ok(match answer {
                Ok(counts) => PdfIntake::Counts(*counts),
                Err(message) => PdfIntake::Rejected(message.clone()),
            })
        }
    }
    struct NoStore;
    #[async_trait]
    impl AttachmentReader for NoStore {
        async fn read(&self, _: &str) -> Result<Vec<u8>, ReadError> {
            unreachable!("the prompts carry their PDFs inline")
        }
    }

    /// `fixtures/pdf-intake/*.json` (`record-pdf-intake.mjs`): Node's turn intake of a prompt with one PDF, at and just
    /// past each limit, encrypted, damaged and scanned. The same prompt here: refused with Node's text where Node threw,
    /// accepted where Node accepted. The inspector answers what Node's parser answered for the same bytes (the
    /// extension host runs Node's own `inspectPdfBuffer`); the limits are the intake's.
    #[tokio::test]
    async fn a_pdf_is_admitted_or_refused_at_the_turn_intake_as_node_does() {
        let dir = format!("{}/../../fixtures/pdf-intake", env!("CARGO_MANIFEST_DIR"));
        let cases: Vec<Value> = ["size-at-limit", "size-over-limit", "pages-100", "pages-101", "pages-101-text", "encrypted", "damaged", "scanned-text-only"]
            .iter()
            .map(|name| serde_json::from_str(&std::fs::read_to_string(format!("{dir}/{name}.json")).expect("recording")).expect("json"))
            .collect();
        let bytes_of = |case: &Value| -> Vec<u8> {
            match case["pdfBase64"].as_str() {
                Some(data) => STANDARD.decode(data).unwrap(),
                None => {
                    let mut bytes = STANDARD.decode(case["padFrom"].as_str().unwrap()).unwrap();
                    bytes.resize(case["sizeBytes"].as_u64().unwrap() as usize, b' ');
                    bytes
                }
            }
        };
        let counts_of = |case: &Value| -> Result<PdfCounts, String> {
            // The prepared prompt as Node recorded it (`exact` of plain JSON is the JSON): the PDF is its second part.
            let part = &case["prompt"][1];
            let number = |key: &str| part[key].as_u64();
            match (number("pageCount"), &case["error"]) {
                (Some(page_count), _) => Ok(PdfCounts { page_count, text_pages: number("textPages").unwrap(), text_chars: number("textChars").unwrap() }),
                (None, error) if error["name"] == "RangeError" && error["message"].as_str().unwrap().starts_with("PDF has ") => {
                    let pages = error["message"].as_str().unwrap()["PDF has ".len()..].split(' ').next().unwrap().parse().unwrap();
                    Ok(PdfCounts { page_count: pages, text_pages: pages, text_chars: 0 })
                }
                (None, error) => Err(error["message"].as_str().unwrap().to_owned()),
            }
        };
        let inspected = cases.iter().filter(|case| case["sizeBytes"].as_u64().unwrap() <= 20 * 1024 * 1024).map(|case| (bytes_of(case), counts_of(case))).collect();
        let intake = PdfPromptIntake { reader: Arc::new(NoStore), docs: Arc::new(Inspected(inspected)), native_pdf: Arc::new(|provider| provider == "native") };
        let thread = ThreadId::from("t");
        for case in &cases {
            let params = serde_json::json!({ "input": { "prompt": [
                { "type": "text", "text": "read the attached document" },
                { "type": "file", "mimeType": "application/pdf", "filename": format!("{}.pdf", case["scenario"].as_str().unwrap()), "data": STANDARD.encode(bytes_of(case)) },
            ] } });
            let provider = if case["nativePdf"] == true { "native" } else { "text" };
            let answer = intake.admit(&thread, provider, &params).await;
            match case["error"]["message"].as_str() {
                Some(message) => assert_eq!(answer, Err(message.to_owned()), "{}", case["scenario"]),
                None => assert_eq!(answer, Ok(()), "{}", case["scenario"]),
            }
        }
    }
}
