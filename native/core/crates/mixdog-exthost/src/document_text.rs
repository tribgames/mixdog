//! `DocumentText` over the pool: the attached-document text Node's provider lowering produces, asked
//! of a worker so it is Node's own extraction (`media.officeText`, `media.pdfText`). Dropping the
//! future cancels the call.

use std::sync::Arc;

use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::PdfCounts;
use mixdog_core_api::domain::ext::PdfIntake;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde_json::json;

pub struct ExtDocumentText {
    pool: Arc<dyn ExtPool>,
}

impl ExtDocumentText {
    pub fn new(pool: Arc<dyn ExtPool>) -> Self {
        Self { pool }
    }

    async fn ask(&self, thread: &ThreadId, method: &str, params: JsonValue) -> Result<JsonValue, ExtError> {
        let mut stream = self.pool.call(ExtCall {
            thread: thread.clone(),
            method: method.to_owned(),
            params,
            paths: Vec::new(),
        })?;
        loop {
            match stream.next().await {
                Some(ExtFrame::Chunk(_)) => {}
                Some(ExtFrame::Done(outcome)) => return outcome,
                None => return Err(ExtError::UnknownWorker),
            }
        }
    }
}

fn malformed(method: &str) -> ExtError {
    ExtError::Failed {
        code: "bad_answer".to_owned(),
        message: format!("{method} answered without text"),
    }
}

#[async_trait::async_trait]
impl DocumentText for ExtDocumentText {
    async fn office_text(&self, thread: &ThreadId, filename: &str, data_base64: &str) -> Result<Option<String>, ExtError> {
        let answer = self
            .ask(thread, "media.officeText", json!({ "data": data_base64, "filename": filename }))
            .await?;
        match answer.get("text") {
            Some(JsonValue::Null) => Ok(None),
            Some(JsonValue::String(text)) => Ok(Some(text.clone())),
            _ => Err(malformed("media.officeText")),
        }
    }

    async fn pdf_text(&self, thread: &ThreadId, data_base64: &str) -> Result<String, ExtError> {
        let answer = self.ask(thread, "media.pdfText", json!({ "data": data_base64 })).await?;
        answer["text"].as_str().map(str::to_owned).ok_or_else(|| malformed("media.pdfText"))
    }

    async fn pdf_counts(&self, thread: &ThreadId, data_base64: &str) -> Result<PdfIntake, ExtError> {
        let answer = self.ask(thread, "media.pdfCounts", json!({ "data": data_base64 })).await?;
        if let Some(message) = answer.get("rejected") {
            return message.as_str().map(|m| PdfIntake::Rejected(m.to_owned())).ok_or_else(|| malformed("media.pdfCounts"));
        }
        let Some(counts) = answer.get("counts") else {
            return Err(malformed("media.pdfCounts"));
        };
        let field = |name: &str| counts.get(name).and_then(JsonValue::as_u64);
        match (field("pageCount"), field("textPages"), field("textChars")) {
            (Some(page_count), Some(text_pages), Some(text_chars)) => {
                Ok(PdfIntake::Counts(PdfCounts { page_count, text_pages, text_chars }))
            }
            _ => Err(malformed("media.pdfCounts")),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::ext::ExtWorkerId;
    use mixdog_core_api::domain::ext::ExtWorkerStatus;

    use super::*;

    struct One(Option<ExtFrame>);

    #[async_trait::async_trait]
    impl EventSource<ExtFrame> for One {
        async fn next(&mut self) -> Option<ExtFrame> {
            self.0.take()
        }
    }

    struct Scripted {
        answer: Result<JsonValue, ExtError>,
        seen: Mutex<Vec<ExtCall>>,
    }

    impl ExtPool for Scripted {
        fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
            self.seen.lock().unwrap().push(call);
            Ok(Box::new(One(Some(ExtFrame::Done(self.answer.clone())))))
        }
        fn status(&self) -> Vec<ExtWorkerStatus> {
            Vec::new()
        }
        fn stop_worker(&self, _: ExtWorkerId) -> Result<(), ExtError> {
            Err(ExtError::UnknownWorker)
        }
    }

    fn media(answer: Result<JsonValue, ExtError>) -> (ExtDocumentText, Arc<Scripted>) {
        let pool = Arc::new(Scripted { answer, seen: Mutex::new(Vec::new()) });
        (ExtDocumentText::new(pool.clone()), pool)
    }

    #[tokio::test]
    async fn the_bytes_go_to_the_worker_untouched_and_no_path_is_approved() {
        let (media, pool) = media(Ok(json!({ "text": "hello" })));
        let thread = ThreadId::from("t");
        assert_eq!(media.office_text(&thread, "a.docx", "QUJD").await.unwrap().as_deref(), Some("hello"));
        assert_eq!(media.pdf_text(&thread, "UERG").await.unwrap(), "hello");
        let seen = pool.seen.lock().unwrap();
        assert_eq!(seen[0].method, "media.officeText");
        assert_eq!(seen[0].params, json!({ "data": "QUJD", "filename": "a.docx" }));
        assert_eq!(seen[1].method, "media.pdfText");
        assert_eq!(seen[1].params, json!({ "data": "UERG" }));
        assert!(seen.iter().all(|c| c.paths.is_empty() && c.thread == thread));
    }

    #[tokio::test]
    async fn an_unreadable_office_file_is_none_and_a_failure_is_never_text() {
        let thread = ThreadId::from("t");
        let (media_none, _) = media(Ok(json!({ "text": null })));
        assert_eq!(media_none.office_text(&thread, "a.docx", "x").await.unwrap(), None);

        let failure = ExtError::Failed { code: "ENOMEM".into(), message: "out of memory".into() };
        let (failing, _) = media(Err(failure.clone()));
        assert_eq!(failing.pdf_text(&thread, "x").await, Err(failure.clone()));
        assert_eq!(failing.office_text(&thread, "a.docx", "x").await, Err(failure));

        let (empty, _) = media(Ok(json!({})));
        assert!(matches!(empty.pdf_text(&thread, "x").await, Err(ExtError::Failed { .. })));
        assert!(matches!(empty.office_text(&thread, "a.docx", "x").await, Err(ExtError::Failed { .. })));
    }

    #[tokio::test]
    async fn pdf_counts_carry_the_parsers_message_and_a_failure_or_a_partial_answer_is_an_error() {
        let thread = ThreadId::from("t");
        let (ok, pool) = media(Ok(json!({ "counts": { "pageCount": 4, "textPages": 3, "textChars": 120 } })));
        assert_eq!(
            ok.pdf_counts(&thread, "UERG").await.unwrap(),
            PdfIntake::Counts(PdfCounts { page_count: 4, text_pages: 3, text_chars: 120 })
        );
        {
            let seen = pool.seen.lock().unwrap();
            assert_eq!(seen[0].method, "media.pdfCounts");
            assert_eq!(seen[0].params, json!({ "data": "UERG" }));
            assert!(seen[0].paths.is_empty());
        }

        let (rejected, _) = media(Ok(json!({ "rejected": "Invalid PDF structure." })));
        assert_eq!(rejected.pdf_counts(&thread, "x").await.unwrap(), PdfIntake::Rejected("Invalid PDF structure.".into()));
        let (bad, _) = media(Ok(json!({ "rejected": 7 })));
        assert!(matches!(bad.pdf_counts(&thread, "x").await, Err(ExtError::Failed { .. })));

        let timeout = ExtError::Failed { code: "PDF_INSPECTION_TIMEOUT".into(), message: "timed out".into() };
        let (failing, _) = media(Err(timeout.clone()));
        assert_eq!(failing.pdf_counts(&thread, "x").await, Err(timeout));

        let (partial, _) = media(Ok(json!({ "counts": { "pageCount": 4 } })));
        assert!(matches!(partial.pdf_counts(&thread, "x").await, Err(ExtError::Failed { .. })));
        let (missing, _) = media(Ok(json!({})));
        assert!(matches!(missing.pdf_counts(&thread, "x").await, Err(ExtError::Failed { .. })));
    }
}
