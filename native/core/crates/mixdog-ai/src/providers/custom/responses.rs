//! Effort history and compatibility fallback on the configured custom Responses wire only.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::{DeliveryState, ModelListing, ModelRequest, ModelStream, ProviderAdapter, ProviderError, StreamEvent, WireCodec};
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use super::ReasoningSource;
use crate::providers::connect::rewrite::HttpAdapter;
use crate::service::effort_configuration::model_key;

type Route = (ProviderId, String);

static REJECTED: LazyLock<Mutex<HashSet<Route>>> = LazyLock::new(Mutex::default);

pub(crate) struct RejectedHistory(&'static Mutex<HashSet<Route>>);

impl Default for RejectedHistory {
    fn default() -> Self {
        Self(&REJECTED)
    }
}

/// A new process has no route whose effort history a provider refused.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset_rejected() {
    REJECTED.lock().unwrap_or_else(PoisonError::into_inner).clear();
}

/// `model` is already normalized by the effort-configuration gate.
pub(crate) fn history_rejected(provider: &str, model: &str) -> bool {
    REJECTED.lock().unwrap_or_else(PoisonError::into_inner).contains(&(ProviderId::from(provider), model.to_owned()))
}

pub(crate) struct ResponsesAdapter {
    inner: Arc<HttpAdapter>,
    reasoning: ReasoningSource,
    rejected: Arc<RejectedHistory>,
}

impl ResponsesAdapter {
    pub(crate) fn new(inner: HttpAdapter, reasoning: ReasoningSource, rejected: Arc<RejectedHistory>) -> Self {
        Self { inner: Arc::new(inner), reasoning, rejected }
    }
}

fn rejected_update(error: &ProviderError, wire_efforts: &[String]) -> bool {
    if error.status != Some(400) || error.unsafe_to_retry || error.exposure.text_emitted || error.exposure.tool_dispatched || error.exposure.tool_input_cut {
        return false;
    }
    let text = error.message.to_ascii_lowercase();
    if ["clear_at", "clear-at", "turn-scoped"].into_iter().any(|field| text.contains(field)) {
        return false;
    }
    static FIELD: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?:output_config|reasoning)\.effort\b").expect("static regex"));
    static QUOTED: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"'([^']*)'|"([^"]*)"|`([^`]*)`"#).expect("static regex"));
    let explicit_update = ["configuration_update", "mid-conversation", "reasoning_effort_update"].into_iter().any(|field| text.contains(field));
    if (FIELD.is_match(&text) || explicit_update)
        && QUOTED.captures_iter(&text).any(|matched| {
            (1..=3).filter_map(|index| matched.get(index)).any(|value| {
                let value = value.as_str();
                wire_efforts.iter().any(|effort| effort.eq_ignore_ascii_case(value))
                    || (!explicit_update && (super::reasoning::EFFORT_LEVELS.contains(&value) || value == "ultra"))
            })
        })
    {
        return false;
    }
    explicit_update || text.contains("output_config")
}

struct WithoutHistory {
    inner: Arc<HttpAdapter>,
    request: Arc<ModelRequest>,
    rejected: Arc<RejectedHistory>,
    route: Route,
    wire_efforts: Vec<String>,
}

impl WithoutHistory {
    async fn resend(self) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.rejected.0.lock().unwrap_or_else(PoisonError::into_inner).insert(self.route);
        self.request.options.send_identity.remint();
        self.inner.attempt(self.request).await
    }
}

#[async_trait]
impl ProviderAdapter for ResponsesAdapter {
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }

    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }

    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        self.inner.models()
    }

    fn native_pdf(&self) -> bool {
        self.inner.native_pdf()
    }

    fn native_documents(&self) -> Option<bool> {
        self.inner.native_documents()
    }

    fn input_excludes_cache(&self) -> Option<bool> {
        self.inner.input_excludes_cache()
    }

    async fn media_support(&self, request: &ModelRequest) -> mixdog_core_api::domain::provider::MediaSupport {
        self.inner.media_support(request).await
    }

    async fn takes_vision(&self, request: &ModelRequest) -> bool {
        self.inner.takes_vision(request).await
    }

    async fn image_route(&self, request: &ModelRequest) -> mixdog_image_egress::route::RouteFacts {
        self.inner.image_route(request).await
    }

    fn release_send(&self, group: &str) {
        self.inner.release_send(group);
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        if request.options.effort_projection.is_none() {
            return self.inner.attempt(request).await;
        }
        let route = (self.id().clone(), model_key(&serde_json::Value::from(request.model.as_str())));
        let rejected = self.rejected.0.lock().unwrap_or_else(PoisonError::into_inner).contains(&route);
        let mut plain = Arc::unwrap_or_clone(request);
        let projection = (!rejected).then(|| self.reasoning.responses_projection(&plain)).flatten();
        plain.options.effort_projection = None;
        let Some(projection) = projection else {
            return self.inner.attempt(Arc::new(plain)).await;
        };
        let wire_efforts = std::iter::once(&projection.initial_effort).chain(projection.updates.values()).cloned().collect();
        let mut projected = plain.clone();
        projected.options.effort_projection = Some(projection);
        let fallback = WithoutHistory { inner: self.inner.clone(), request: Arc::new(plain), rejected: self.rejected.clone(), route, wire_efforts };
        match self.inner.attempt(Arc::new(projected)).await {
            Err(error) if rejected_update(&error, &fallback.wire_efforts) => fallback.resend().await,
            Err(error) => Err(error),
            Ok(inner) => Ok(Box::new(BeforeOutput { inner, fallback: Some(fallback), left: None })),
        }
    }
}

struct BeforeOutput {
    inner: Box<dyn ModelStream>,
    fallback: Option<WithoutHistory>,
    left: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[async_trait]
impl ModelStream for BeforeOutput {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        let item = self.inner.next().await;
        match &item {
            Some(Err(error)) => {
                if let Some(fallback) = self.fallback.take()
                    && rejected_update(error, &fallback.wire_efforts)
                {
                    match fallback.resend().await {
                        Ok(mut stream) => {
                            if let Some(left) = &self.left {
                                stream.on_wire_left(left.clone());
                            }
                            self.inner = stream;
                            return self.inner.next().await;
                        }
                        Err(error) => return Some(Err(error)),
                    }
                }
            }
            Some(Ok(event))
                if matches!(event.progress_kind(), Some("text" | "reasoning" | "tool"))
                    || matches!(
                        event,
                        StreamEvent::ToolCallStart { .. }
                            | StreamEvent::ToolCallArgsDelta { .. }
                            | StreamEvent::ToolCallDone(_)
                            | StreamEvent::FinalContent(_)
                            | StreamEvent::Completed { .. }
                    ) =>
            {
                self.fallback = None;
            }
            _ => {}
        }
        item
    }

    fn delivery(&self) -> DeliveryState {
        self.inner.delivery()
    }

    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>) {
        self.inner.on_wire_left(left.clone());
        self.left = Some(left);
    }
}

#[cfg(test)]
mod rejection_tests {
    use super::*;
    use mixdog_core_api::domain::provider::ErrorKind;

    #[tokio::test]
    async fn seed_only_history_falls_back_once_and_remembers_the_refusal() {
        use super::super::{CustomRequestConfig, CustomRewriter, Protocol, responses_codec};
        use crate::providers::compat::profile::CredentialKind;
        use crate::providers::connect::rewrite::{RewriteCodec, StaticCredential};
        use crate::providers::listing_row::testing::Replay;
        use mixdog_core_api::domain::provider::{Content, EffortProjection, Message, RequestOptions, Role};
        use serde_json::{Value, json};

        struct Rows;
        impl crate::catalog::CachedModelInfo for Rows {
            fn cached_row(&self, _: &str) -> Option<Arc<Value>> {
                Some(Arc::new(json!({"reasoningLevels": ["low", "high"], "customReasoning": {"wireValues": {"low": "lite", "high": "deep"}}})))
            }
        }
        let http = Arc::new(Replay::new(|request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            if body["reasoning"]["effort"] == "lite" {
                (400, br#"{"error":{"message":"mid-conversation effort is not supported"}}"#.to_vec())
            } else {
                (200, b"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"ok\",\"status\":\"completed\",\"output\":[]}}\n\n".to_vec())
            }
        }));
        let provider = "custom-seed-only-history-regression";
        let url = "http://127.0.0.1/v1";
        let reasoning = ReasoningSource { rows: Arc::new(Rows), configured: None, base_url: url.into() };
        let codec = RewriteCodec::new(
            responses_codec(provider, url),
            CustomRewriter { config: CustomRequestConfig::default(), wire: Protocol::OpenaiResponses, reasoning: reasoning.clone() },
        );
        let policy = crate::providers::compat::CompatProfile::plain(provider, url, CredentialKind::Keyless).retry_policy();
        let inner = HttpAdapter::new(ProviderId::from(provider), Arc::new(codec), http.clone(), Arc::new(StaticCredential(None)), policy);
        let adapter = ResponsesAdapter::new(inner, reasoning, Arc::default());
        let request = Arc::new(ModelRequest {
            model: "gateway/gpt-6".into(),
            messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
            tools: Vec::new(),
            options: RequestOptions {
                effort: Some("high".into()),
                effort_projection: Some(EffortProjection { initial_effort: "low".into(), updates: Default::default() }),
                ..RequestOptions::default()
            },
        });
        for _ in 0..2 {
            let mut stream = adapter.attempt(request.clone()).await.unwrap();
            loop {
                if matches!(stream.next().await.expect("terminal event").unwrap(), StreamEvent::Completed { .. }) {
                    break;
                }
            }
        }
        assert!(history_rejected(provider, "gateway/gpt-6"));
        let sent = http.requests.lock().unwrap();
        assert!(sent.iter().all(|request| request.url == "http://127.0.0.1/v1/responses"));
        let efforts: Vec<Value> = sent.iter().map(|r| serde_json::from_slice::<Value>(&r.body).unwrap()["reasoning"]["effort"].clone()).collect();
        assert_eq!(efforts, [json!("lite"), json!("deep"), json!("deep")]);
    }

    #[test]
    fn a_rejected_effort_field_falls_back_but_a_rejected_level_does_not() {
        let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::Accepted);
        error.status = Some(400);
        error.message = "output_config.effort is not supported".into();
        let mapped = ["deep".to_owned()];
        assert!(rejected_update(&error, &mapped));
        error.message = "output_config.effort: value 'HIGH' is not supported".into();
        assert!(!rejected_update(&error, &mapped));
        error.message = "output_config.effort: value 'DEEP' is not supported".into();
        assert!(!rejected_update(&error, &mapped));
        error.message = "configuration_update rejected reasoning.effort value `deep`".into();
        assert!(!rejected_update(&error, &mapped));
        error.message = "turn-scoped clear_at is unsupported with output_config".into();
        assert!(!rejected_update(&error, &mapped));
    }
}
