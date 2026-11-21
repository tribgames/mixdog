use mixdog_core_api::domain::provider::EnrichedRow;
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
    record.name = text("name");
    record.provider_name = text("providerName");
    record.manual = flag("manual") == Some(true);
    record.supports_reasoning_effort_updates = flag("supportsReasoningEffortUpdates");
    record.supports_prompt_caching = flag("supportsPromptCaching");
    record.reasoning_content_field = text("reasoningContentField");
    record.context_window = count("contextWindow");
    record.max_context_window = count("maxContextWindow");
    record.runtime_context_window = count("runtimeContextWindow");
    record.max_output_tokens = count("outputTokens");
    record.supports_reasoning = flag("supportsReasoning");
    record.reasoning_levels = typed(&row, "reasoningLevels");
    record.default_reasoning_level = text("defaultEffort");
    record.supports_images = flag("supportsVision").or_else(|| flag("supportsImages"));
    record.hidden = flag("hidden") == Some(true);
    record.mode = text("mode");
    record.created = row.get("created").and_then(Value::as_i64);
    // The picker's fields are the row's own keys (`fastEfforts`,
    // `modelParameterOptions`, `parameterVariants`, `releaseDate`, `tier`, `latest`,
    // `description`, `defaultModelParameters`, `defaultFast`, `supportsMaxMode`, ...).
    record.picker = serde_json::from_value(Value::Object(row.clone())).unwrap_or_default();
    // The provider's row is the row it stores and answers (`getCachedModelInfo`): the catalog keeps it as stated, and a
    // later `enrichModels` writes over it (`{ ...row, ...enrichment }`).
    record.enriched = EnrichedRow(Some(row.clone()));
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
        async fn send(&self, request: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            let (status, body) = (self.answer)(&request);
            self.requests.lock().unwrap().push(request);
            Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(Once(Some(Bytes::from(body)))) })
        }
    }
}
