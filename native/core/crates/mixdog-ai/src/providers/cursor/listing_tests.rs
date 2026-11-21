//! Replays what Node's `listModels` recorded (`providers/cursor-models`): the
//! same `AvailableModels` answer must give the same rows, and the same
//! request must be sent.
#![cfg(test)]

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;

use super::Access;
use super::AccessToken;
use super::CLIENT_VERSION_FLOOR;
use super::CursorAdapter;
use crate::providers::listing_row::testing::Replay;
use crate::transport::http::BidiOpen;
use crate::transport::http::FrameSink;
use crate::transport::http::HttpResponse;

struct Token;

#[async_trait]
impl AccessToken for Token {
    async fn access_token(&self) -> Result<Access, ProviderError> {
        Ok(Access::plain("fixture-cursor-token".to_owned()))
    }
    async fn after_rejection(&self, _rejected: &Access) -> Result<Access, ProviderError> {
        self.access_token().await
    }
    async fn renewed(&self) -> Result<Access, ProviderError> {
        self.access_token().await
    }
}

/// An in-place retry finds the account signed out while it obtains its credential: that is the retry's one credential
/// decision. Nothing is sent on the token the first attempt went out on.
#[tokio::test(start_paused = true)]
async fn an_in_place_retry_that_finds_the_sign_out_sends_nothing() {
    /// An account whose sign-in is removed while a renewal of it runs: a plain read still finds the token, a renewal
    /// finds the account signed out.
    struct Leaving;

    impl Leaving {
        fn signed_out() -> ProviderError {
            let mut error = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Auth, mixdog_core_api::domain::provider::DeliveryState::NotSent);
            error.reauth_required = true;
            error.message = "Cursor OAuth is not connected.".to_owned();
            error
        }
    }

    #[async_trait]
    impl AccessToken for Leaving {
        async fn access_token(&self) -> Result<Access, ProviderError> {
            Ok(Access::plain("token-before-the-sign-out".to_owned()))
        }
        async fn after_rejection(&self, _rejected: &Access) -> Result<Access, ProviderError> {
            Err(Self::signed_out())
        }
        async fn renewed(&self) -> Result<Access, ProviderError> {
            Err(Self::signed_out())
        }
    }

    struct NoBody;
    #[async_trait]
    impl crate::transport::http::BodyStream for NoBody {
        async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
            None
        }
    }
    struct Silent;
    impl FrameSink for Silent {
        fn send(&self, _: Vec<u8>) -> Result<(), mixdog_core_api::domain::provider::TransportFault> {
            Ok(())
        }
    }
    /// Every run is refused with a 500; the bearer of each is kept.
    struct Down(std::sync::Mutex<Vec<String>>);
    #[async_trait]
    impl BidiOpen for Down {
        async fn open(&self, request: WireRequest, _: Vec<u8>, _: crate::transport::Exchange) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
            let bearer = request.headers.iter().find(|(name, _)| name == "authorization").map(|(_, value)| value.clone()).unwrap_or_default();
            self.0.lock().unwrap().push(bearer);
            Ok((HttpResponse { status: 500, headers: vec![], body: Box::new(NoBody) }, Arc::new(Silent)))
        }
    }

    let http = Arc::new(Replay::new(|_| (500, Vec::new())));
    let runs = Arc::new(Down(Default::default()));
    let adapter = CursorAdapter::new("cursor-api", None, Some(CLIENT_VERSION_FLOOR.into()), http, runs.clone(), Arc::new(Leaving));
    let request = Arc::new(mixdog_core_api::domain::provider::ModelRequest {
        model: "auto".into(),
        messages: vec![mixdog_core_api::domain::provider::Message::new(
            mixdog_core_api::domain::provider::Role::User,
            mixdog_core_api::domain::provider::Content::Text("hi".into()),
        )],
        tools: vec![],
        options: Default::default(),
    });
    assert_eq!(adapter.attempt(request.clone()).await.err().expect("the run is refused").status, Some(500));
    let error = adapter.attempt(request.clone()).await.err().expect("the retry is signed out");
    assert!(error.reauth_required, "{}", error.message);
    assert_eq!(*runs.0.lock().unwrap(), ["Bearer token-before-the-sign-out"], "the retry sent the signed-out account's token");
}

/// Listing opens no run.
struct NoRun;

#[async_trait]
impl BidiOpen for NoRun {
    async fn open(
        &self,
        _request: WireRequest,
        _first: Vec<u8>,
        _exchange: crate::transport::Exchange,
    ) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
        unreachable!("a listing opens no run")
    }
}

fn adapter(answer: Vec<u8>) -> (Arc<Replay>, CursorAdapter) {
    let http = Arc::new(Replay::new(move |_request: &WireRequest| (200, answer.clone())));
    let adapter = CursorAdapter::new("cursor-api", None, Some(CLIENT_VERSION_FLOOR.into()), http.clone(), Arc::new(NoRun), Arc::new(Token));
    (http, adapter)
}

#[tokio::test(start_paused = true)]
async fn an_answer_without_parameterized_models_falls_to_the_static_list() {
    // `getCursorModels`: no row from either call after the retries answers `FALLBACK_MODELS`, not an error.
    let (_http, adapter) = adapter(Vec::new());
    let records = adapter.models().unwrap().list_models().await.unwrap();
    assert_eq!(records[0].id, "auto");
    assert!(records.iter().any(|r| r.id == "composer-2.5"));
}

fn lists_with(answer: impl Fn(&WireRequest) -> (u16, Vec<u8>) + Send + Sync + 'static) -> (Arc<Replay>, CursorAdapter) {
    let http = Arc::new(Replay::new(answer));
    let adapter = CursorAdapter::new("cursor-api", None, Some(CLIENT_VERSION_FLOOR.into()), http.clone(), Arc::new(NoRun), Arc::new(Token));
    (http, adapter)
}

/// `AvailableModels` answering no rows falls to the legacy `GetUsableModels` (`fetchCursorModelsOnce`).
#[tokio::test]
async fn an_empty_available_models_falls_to_the_legacy_call() {
    let (http, adapter) = lists_with(|request| {
        if request.url.ends_with("/GetUsableModels") {
            // ModelDetails { modelId: "m1", displayName: "Model One" }
            (200, vec![0x0A, 0x0F, 0x0A, 0x02, b'm', b'1', 0x22, 0x09, b'M', b'o', b'd', b'e', b'l', b' ', b'O', b'n', b'e'])
        } else {
            (200, Vec::new())
        }
    });
    let records = adapter.models().expect("lists").list_models().await.unwrap();
    let ids: Vec<&str> = records.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["auto", "m1"]);
    assert_eq!(records[1].display_name.as_deref(), Some("Model One"));
    assert_eq!(http.requests.lock().unwrap().len(), 2);
}
/// `_loadCursorCatalog` is one cache: the rows a listing refreshed are the catalog the next send resolves from.
#[tokio::test]
async fn a_listing_refreshes_the_catalog_the_sends_read() {
    let (_http, adapter) = lists_with(|request| {
        if request.url.ends_with("/GetUsableModels") {
            (200, vec![0x0A, 0x0F, 0x0A, 0x02, b'm', b'1', 0x22, 0x09, b'M', b'o', b'd', b'e', b'l', b' ', b'O', b'n', b'e'])
        } else {
            (200, Vec::new())
        }
    });
    assert!(adapter.catalog.load_full().is_none());
    adapter.models().expect("lists").list_models().await.unwrap();
    let kept = adapter.catalog.load_full().expect("the listing's catalog is kept for sends");
    assert!(kept.iter().any(|m| m.id == "m1"));
}

/// Node's `session.selectedContextWindow` decides Max mode: the route's saved `context` choice names the window.
#[test]
fn the_routes_context_choice_is_the_selected_window() {
    let window = |route: serde_json::Value| super::selected_context_window(route.as_object());
    assert_eq!(window(serde_json::json!({"context": "1m"})), Some(1_000_000));
    assert_eq!(window(serde_json::json!({"context": "272k"})), Some(272_000));
    assert_eq!(window(serde_json::json!({"context": "1m", "selectedContextWindow": 500_000})), Some(500_000));
    assert_eq!(window(serde_json::json!({"effort": "high"})), None);
    assert_eq!(super::selected_context_window(None), None);
}

/// The session's `selectedContextWindow` rides the request's `model_parameters` beside the route's choices (the header
/// key `mixdog-core` must copy there, as it does `providerCacheOpts`): a window above the model's standard one selects its
/// Max variant on the adapter's own selection path.
#[test]
fn the_sessions_selected_window_picks_the_max_variant_on_the_adapters_path() {
    use super::models::{CursorModel, Variant};
    let variant = |max_mode| Variant { parameters: vec![], max_mode, default_max: max_mode, default_non_max: !max_mode, legacy_slug: String::new() };
    let model = CursorModel {
        id: "m".into(),
        name: "M".into(),
        description: String::new(),
        context_window: 200_000,
        max_context_window: 1_000_000,
        supports_max_mode: true,
        supports_non_max_mode: true,
        supports_vision: false,
        supports_reasoning: false,
        definitions: vec![],
        variants: vec![variant(false), variant(true)],
        aliases: vec![],
    };
    let (_http, adapter) = adapter(Vec::new());
    let ask = |parameters: Option<serde_json::Value>| {
        let request = mixdog_core_api::domain::provider::ModelRequest {
            model: "m".into(),
            messages: vec![],
            tools: vec![],
            options: mixdog_core_api::domain::provider::RequestOptions { model_parameters: parameters, ..Default::default() },
        };
        adapter.selection(std::slice::from_ref(&model), &request).unwrap().max_mode
    };
    assert!(!ask(None));
    assert!(!ask(Some(serde_json::json!({"selectedContextWindow": 200_000}))));
    assert!(ask(Some(serde_json::json!({"selectedContextWindow": 1_000_000}))));
}

/// A cold send's discovery never replaces a newer catalog the picker installed while it was fetching.
#[tokio::test(start_paused = true)]
async fn a_cold_fill_does_not_replace_a_newer_catalog() {
    use super::models::fallback_models;
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let (_http, adapter) = lists_with(move |request| {
        // The first round (both calls) fails, so the discovery is still backing off when the picker installs its catalog.
        if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2 {
            (500, Vec::new())
        } else if request.url.ends_with("/GetUsableModels") {
            (200, vec![0x0A, 0x0F, 0x0A, 0x02, b'm', b'1', 0x22, 0x09, b'M', b'o', b'd', b'e', b'l', b' ', b'O', b'n', b'e'])
        } else {
            (200, Vec::new())
        }
    });
    let mut newer = fallback_models();
    newer.retain(|m| m.id == "auto");
    newer[0].name = "picker".into();
    let (cold, ()) = tokio::join!(adapter.cached_models("t"), async {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        adapter.catalog.store(Some(Arc::new(newer.clone())));
    });
    assert_eq!(cold.unwrap()[0].name, "picker", "the send resolves from the newer catalog");
    assert_eq!(adapter.catalog.load_full().unwrap()[0].name, "picker");
}

/// A cold send whose discovery fails entirely answers from the live catalog the picker installed meanwhile, not from the static
/// list, and never keeps the static list.
#[tokio::test(start_paused = true)]
async fn an_exhausted_cold_discovery_prefers_the_installed_catalog_to_the_fallback() {
    use super::models::fallback_models;
    let (_http, adapter) = lists_with(|_| (500, Vec::new()));
    let mut installed = fallback_models();
    installed.retain(|m| m.id == "auto");
    installed[0].name = "picker".into();
    let (cold, ()) = tokio::join!(adapter.cached_models("t"), async {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        adapter.catalog.store(Some(Arc::new(installed.clone())));
    });
    let cold = cold.unwrap();
    assert_eq!((cold.len(), cold[0].name.as_str()), (1, "picker"));
    assert_eq!(adapter.catalog.load_full().unwrap()[0].name, "picker");
}

/// A throttle that ends a run after output (an end frame, not a refused open) still rotates the conversation for the
/// retry; the scope's record goes when the scope ends.
#[tokio::test]
async fn a_streamed_throttle_rotates_the_next_conversation_and_a_released_scope_forgets_it() {
    struct Silent;
    impl FrameSink for Silent {
        fn send(&self, _: Vec<u8>) -> Result<(), mixdog_core_api::domain::provider::TransportFault> {
            Ok(())
        }
    }
    struct NoBody;
    #[async_trait]
    impl crate::transport::http::BodyStream for NoBody {
        async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
            None
        }
    }
    mixdog_rt::testing::tokens();
    let (_http, adapter) = adapter(Vec::new());
    let derived = adapter.conversation_of("s1");
    assert_eq!(adapter.conversation_of("s1"), derived);
    let mut stream =
        super::CursorStream::new(Box::new(NoBody), Arc::new(Silent), super::decoder::CursorDecoder::new(Default::default(), Vec::new(), None), "t".into());
    stream.throttle = Some((adapter.rotated.clone(), "s1".into()));
    let mut throttle =
        ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::RateLimited, mixdog_core_api::domain::provider::DeliveryState::Accepted);
    throttle.status = Some(429);
    stream.fail(throttle);
    let retry = adapter.conversation_of("s1");
    assert_ne!(retry, derived, "the retry after a streamed throttle sends a fresh conversation id");
    assert_eq!(adapter.conversation_of("s1"), retry, "and keeps it until the next throttle");
    adapter.release_session("s1");
    assert_eq!(adapter.conversation_of("s1"), derived, "a scope that ended is forgotten");
}

/// A throttle can be pinned to one conversation id: the retry after a `resource_exhausted` runs under a fresh one
/// (`cursor-wire.mjs` restart with reason `throttle`).
#[tokio::test(start_paused = true)]
async fn a_throttled_conversation_is_retried_under_a_fresh_id() {
    struct Throttled(std::sync::Mutex<Vec<Vec<u8>>>);

    struct Silent;
    impl FrameSink for Silent {
        fn send(&self, _: Vec<u8>) -> Result<(), mixdog_core_api::domain::provider::TransportFault> {
            Ok(())
        }
    }
    struct NoBody;
    #[async_trait]
    impl crate::transport::http::BodyStream for NoBody {
        async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
            None
        }
    }
    #[async_trait]
    impl BidiOpen for Throttled {
        async fn open(&self, _: WireRequest, first: Vec<u8>, _: crate::transport::Exchange) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
            self.0.lock().unwrap().push(first);
            Ok((HttpResponse { status: 429, headers: vec![], body: Box::new(NoBody) }, Arc::new(Silent)))
        }
    }

    let http = Arc::new(Replay::new(|_| (500, Vec::new())));
    let runs = Arc::new(Throttled(Default::default()));
    let adapter = CursorAdapter::new("cursor-api", None, Some(CLIENT_VERSION_FLOOR.into()), http, runs.clone(), Arc::new(Token));
    let request = Arc::new(mixdog_core_api::domain::provider::ModelRequest {
        model: "auto".into(),
        messages: vec![mixdog_core_api::domain::provider::Message::new(
            mixdog_core_api::domain::provider::Role::User,
            mixdog_core_api::domain::provider::Content::Text("hi".into()),
        )],
        tools: vec![],
        options: mixdog_core_api::domain::provider::RequestOptions { session_id: Some("s1".into()), ..Default::default() },
    });
    for _ in 0..2 {
        let error = adapter.attempt(request.clone()).await.err().expect("throttled");
        assert_eq!(error.status, Some(429));
    }
    let bodies = runs.0.lock().unwrap();
    assert_eq!(bodies.len(), 2);
    assert_ne!(bodies[0], bodies[1], "the retry must not reuse the throttled conversation id");
}

/// Three failed rounds (0.5, 1.5, 3 s apart) answer the static list and keep nothing.
#[tokio::test(start_paused = true)]
async fn a_catalog_that_never_answers_lists_the_static_models() {
    let (http, adapter) = lists_with(|_| (500, Vec::new()));
    let records = adapter.models().expect("lists").list_models().await.unwrap();
    assert_eq!(records[0].id, "auto");
    assert!(records.iter().any(|r| r.id == "composer-2.5"));
    // Four rounds of the two calls.
    assert_eq!(http.requests.lock().unwrap().len(), 8);
    assert!(adapter.catalog.load_full().is_none());
    // Neither the catalog nor the cached-model-info rows keep the static list.
    use crate::catalog::CachedModelInfo;
    assert!(adapter.cached_row("composer-2.5").is_none());
    let (_, cached) = lists_with(|_| (500, Vec::new()));
    assert!(cached.cached_models("t").await.unwrap().iter().any(|m| m.id == "composer-2.5"));
    assert!(cached.catalog.load_full().is_none(), "a send's catalog read keeps no fallback either");
}

/// The model list that outlives its timer reads as the real Node call did (`sites.cursorModelsCall`): `callCursorUnary`'s
/// own timer, labelled `Cursor request`.
#[tokio::test(start_paused = true)]
async fn a_model_list_that_outlives_its_timer_reads_as_nodes() {
    use crate::transport::site_probe::{TimingOut, assert_thrown, assert_window};

    let transport = TimingOut::new();
    let adapter = CursorAdapter::new("cursor-api", None, Some(CLIENT_VERSION_FLOOR.into()), transport.clone(), Arc::new(NoRun), Arc::new(Token));
    let error = adapter.fetch_models("t").await.expect_err("never answers");
    assert_window("cursorModelsCall", &transport);
    assert_thrown("cursorModelsCall", &error.message);
}
