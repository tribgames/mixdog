//! Page extraction outside the core's process: an HTML document parses into a tree many times its size, so the
//! extension-host worker does it (`web.extract`) and the core holds only the text that comes back.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;
use url::Url;

use super::error::FetchError;
use super::error::FetchKind;
use super::extract::Extracted;
use super::extract::extract_document;

/// The worker method [`answer`] serves.
pub const EXTRACT_METHOD: &str = "web.extract";
/// The fairness key of the extraction calls, which belong to no one thread.
const EXTRACT_THREAD: &str = "web-extract";

/// What turns a fetched body into a page's text.
#[async_trait]
pub trait PageExtractor: Send + Sync {
    async fn extract(&self, url: Url, body: String, content_type: String) -> Result<Extracted, FetchError>;
}

const KINDS: [(FetchKind, &str); 9] = [
    (FetchKind::Policy, "policy"),
    (FetchKind::Http, "http"),
    (FetchKind::Challenge, "challenge"),
    (FetchKind::NetworkTransient, "network-transient"),
    (FetchKind::Network, "network"),
    (FetchKind::Timeout, "timeout"),
    (FetchKind::StageTimeout, "stage-timeout"),
    (FetchKind::Cancelled, "cancelled"),
    (FetchKind::EmptyContent, "empty-content"),
];

/// The extractor and format names an answer may carry: an [`Extracted`] holds them as constants.
const EXTRACTORS: [&str; 3] = ["raw", "dom-markdown", "readability"];
const FORMATS: [&str; 4] = ["html", "text", "json", "markdown"];

fn failed() -> FetchError {
    FetchError::new(FetchKind::Network, "content extraction failed")
}

/// The worker's side of [`EXTRACT_METHOD`]: `{url, body, contentType}` in, `{ok}` with the page or `{error: {kind,
/// message}}` with the extractor's refusal out. `Err` names a parameter that is not one.
pub fn answer(params: &Value) -> Result<Value, String> {
    let text = |name: &str| params.get(name).and_then(Value::as_str).ok_or_else(|| format!("{name} must be a string"));
    let url = Url::parse(text("url")?).map_err(|error| format!("url must be a URL: {error}"))?;
    Ok(match extract_document(&url, text("body")?, text("contentType")?) {
        Ok(page) => json!({ "ok": {
            "title": page.title,
            "content": page.content,
            "extractor": page.extractor,
            "format": page.format,
            "contentType": page.content_type,
            "excerpt": page.excerpt,
            "excerptJsonLen": page.excerpt_json_len,
        } }),
        Err(error) => {
            let kind = KINDS.iter().find(|(kind, _)| *kind == error.kind).map_or("network", |(_, name)| name);
            json!({ "error": { "kind": kind, "message": error.message } })
        }
    })
}

fn extracted(mut ok: Value) -> Option<Extracted> {
    let mut take = |name: &str| match ok.get_mut(name)?.take() {
        Value::String(text) => Some(text),
        _ => None,
    };
    let (title, content, extractor, format, content_type, excerpt) =
        (take("title")?, take("content")?, take("extractor")?, take("format")?, take("contentType")?, take("excerpt")?);
    Some(Extracted {
        title,
        content,
        extractor: EXTRACTORS.into_iter().find(|name| *name == extractor)?,
        format: FORMATS.into_iter().find(|name| *name == format)?,
        content_type,
        excerpt,
        excerpt_json_len: usize::try_from(ok.get("excerptJsonLen")?.as_u64()?).ok()?,
    })
}

/// [`PageExtractor`] over the extension host's pool. Dropping the future cancels the call.
pub struct HostExtractor {
    pool: Arc<dyn ExtPool>,
}

impl HostExtractor {
    pub fn new(pool: Arc<dyn ExtPool>) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl PageExtractor for HostExtractor {
    async fn extract(&self, url: Url, body: String, content_type: String) -> Result<Extracted, FetchError> {
        let params = json!({ "url": url.as_str(), "body": body, "contentType": content_type });
        let call = ExtCall { thread: ThreadId::from(EXTRACT_THREAD), method: EXTRACT_METHOD.to_owned(), params, paths: Vec::new() };
        let mut stream = self.pool.call(call).map_err(|error| {
            tracing::warn!(?error, "the page could not be extracted: the extension host took no call");
            failed()
        })?;
        let mut answer = loop {
            match stream.next().await {
                Some(ExtFrame::Chunk(_)) => {}
                Some(ExtFrame::Done(Ok(answer))) => break answer,
                Some(ExtFrame::Done(Err(error))) => {
                    tracing::warn!(?error, "the page could not be extracted: the extension host did not answer");
                    return Err(failed());
                }
                None => return Err(failed()),
            }
        };
        if let Some(error) = answer.get("error") {
            let kind = error.get("kind").and_then(Value::as_str).and_then(|name| KINDS.iter().find(|(_, known)| *known == name)).map(|(kind, _)| *kind);
            let message = error.get("message").and_then(Value::as_str);
            return Err(kind.zip(message).map_or_else(failed, |(kind, message)| FetchError::new(kind, message)));
        }
        answer.get_mut("ok").map(Value::take).and_then(extracted).ok_or_else(failed)
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::ext::ExtError;
    use mixdog_core_api::domain::ext::ExtWorkerId;
    use mixdog_core_api::domain::ext::ExtWorkerStatus;

    use super::*;

    struct One(Option<ExtFrame>);

    #[async_trait]
    impl EventSource<ExtFrame> for One {
        async fn next(&mut self) -> Option<ExtFrame> {
            self.0.take()
        }
    }

    /// A pool whose worker is [`answer`] run in place.
    struct InPlace;

    impl ExtPool for InPlace {
        fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
            assert_eq!(call.method, EXTRACT_METHOD);
            let done = answer(&call.params).map_err(|message| ExtError::Failed { code: "invalid_params".to_owned(), message });
            Ok(Box::new(One(Some(ExtFrame::Done(done)))))
        }
        fn status(&self) -> Vec<ExtWorkerStatus> {
            Vec::new()
        }
        fn stop_worker(&self, _: ExtWorkerId) -> Result<(), ExtError> {
            Err(ExtError::UnknownWorker)
        }
    }

    #[tokio::test]
    async fn a_page_extracted_by_the_worker_is_the_page_extracted_in_place() {
        let host = HostExtractor::new(Arc::new(InPlace));
        let url = Url::parse("https://e.com/a/b").unwrap();
        for (body, content_type) in [
            ("<html><head><title> T </title></head><body><main><h1>Head</h1><p>Text of the page.</p></main></body></html>", "text/html; charset=utf-8"),
            ("{\"a\": 1}", "application/json"),
            ("plain words", "text/plain"),
        ] {
            let through = host.extract(url.clone(), body.to_owned(), content_type.to_owned()).await.unwrap();
            assert_eq!(through, extract_document(&url, body, content_type).unwrap(), "{content_type}");
        }
        // The extractor's own refusal crosses with its kind and words.
        let empty = host.extract(url.clone(), "<html><body></body></html>".to_owned(), "text/html".to_owned()).await.unwrap_err();
        let in_place = extract_document(&url, "<html><body></body></html>", "text/html").unwrap_err();
        assert_eq!((empty.kind, empty.message), (in_place.kind, in_place.message));
    }

    #[tokio::test]
    async fn a_host_that_cannot_answer_fails_the_extraction() {
        struct Down;
        impl ExtPool for Down {
            fn call(&self, _: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
                Ok(Box::new(One(Some(ExtFrame::Done(Err(ExtError::Overloaded))))))
            }
            fn status(&self) -> Vec<ExtWorkerStatus> {
                Vec::new()
            }
            fn stop_worker(&self, _: ExtWorkerId) -> Result<(), ExtError> {
                Err(ExtError::UnknownWorker)
            }
        }
        let error =
            HostExtractor::new(Arc::new(Down)).extract(Url::parse("https://e.com/").unwrap(), "x".to_owned(), "text/plain".to_owned()).await.unwrap_err();
        assert_eq!((error.kind, error.message.as_str()), (FetchKind::Network, "content extraction failed"));
    }
}
