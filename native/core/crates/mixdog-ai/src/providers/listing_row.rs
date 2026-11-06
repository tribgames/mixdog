//! The listing row of the providers that keep their Node row shape (`grok`,
//! `cursor`, `devin`, `local`): the provider's row verbatim in
//! [`ModelRecord::raw`] and the typed record read from the same keys, so the
//! two can never disagree.

use mixdog_core_api::domain::provider::ModelRecord;
use serde::de::DeserializeOwned;
use serde_json::Map;
use serde_json::Value;

fn typed<T: DeserializeOwned + Default>(row: &Map<String, Value>, key: &str) -> T {
    row.get(key).and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default()
}

/// The record of one row. Only keys the row states are read; a key the row
/// lacks leaves the typed field unstated.
pub fn record(row: Map<String, Value>) -> ModelRecord {
    let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
    let count = |key: &str| row.get(key).and_then(Value::as_u64).filter(|n| *n > 0);
    let flag = |key: &str| row.get(key).and_then(Value::as_bool);
    let mut record = ModelRecord::new(text("id").unwrap_or_default());
    record.display_name = text("display");
    record.context_window = count("contextWindow");
    record.max_output_tokens = count("outputTokens");
    record.supports_reasoning = flag("supportsReasoning");
    record.reasoning_levels = typed(&row, "reasoningLevels");
    record.default_reasoning_level = text("defaultEffort");
    record.supports_images = flag("supportsVision").or_else(|| flag("supportsImages"));
    record.hidden = flag("hidden") == Some(true);
    record.mode = text("mode");
    record.created = row.get("created").and_then(Value::as_i64);
    // The picker's fields are the row's own keys (`fastEfforts`,
    // `modelParameterOptions`, `parameterVariants`, `releaseDate`, ...).
    record.picker = serde_json::from_value(Value::Object(row.clone())).unwrap_or_default();
    record.raw = Some(Value::Object(row));
    record
}

/// The one scripted network the listing tests share: every request is kept,
/// and the script answers it with a status and a body.
#[cfg(test)]
pub(crate) mod testing {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use bytes::Bytes;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::TransportFault;
    use mixdog_core_api::domain::provider::WireRequest;

    use crate::transport::http::BodyStream;
    use crate::transport::http::HttpResponse;
    use crate::transport::http::HttpSend;

    struct Once(Option<Bytes>);

    #[async_trait]
    impl BodyStream for Once {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            self.0.take().map(Ok)
        }
    }

    pub(crate) struct Replay {
        pub requests: Mutex<Vec<WireRequest>>,
        answer: Box<dyn Fn(&WireRequest) -> (u16, Vec<u8>) + Send + Sync>,
    }

    impl Replay {
        pub fn new(answer: impl Fn(&WireRequest) -> (u16, Vec<u8>) + Send + Sync + 'static) -> Self {
            Self { requests: Mutex::new(Vec::new()), answer: Box::new(answer) }
        }
    }

    #[async_trait]
    impl HttpSend for Replay {
        async fn send(&self, request: WireRequest) -> Result<HttpResponse, ProviderError> {
            let (status, body) = (self.answer)(&request);
            self.requests.lock().unwrap().push(request);
            Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(Once(Some(Bytes::from(body)))) })
        }
    }

    pub(crate) fn fixture(relative: &str) -> serde_json::Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/providers").join(relative);
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{relative}: {e}"))).unwrap()
    }

    pub(crate) fn unhex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }
}
