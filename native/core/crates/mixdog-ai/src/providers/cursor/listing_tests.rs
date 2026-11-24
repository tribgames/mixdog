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

/// An account whose sign-in Cursor refuses still has its models in the catalog: the static list answers within the
/// catalog's listing deadline instead of the provider going missing.
#[tokio::test(start_paused = true)]
async fn a_refused_sign_in_still_lists_the_static_models_in_the_catalog() {
    let http = Arc::new(Replay::new(|_request: &WireRequest| (401, Vec::new())));
    let adapter = CursorAdapter::new("cursor-oauth", None, Some(CLIENT_VERSION_FLOOR.into()), http, Arc::new(NoRun), Arc::new(Token));
    let provider = mixdog_protocol::ProviderId::from("cursor-oauth");
    let source = crate::catalog::ModelSource::of_adapter(provider.clone(), Arc::new(adapter)).expect("Cursor lists models");
    let catalog = crate::catalog::ProviderCatalog::new(crate::catalog::CatalogSnapshot::default());
    let outcome = catalog.refresh(&[source]).await;
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed.iter().map(|(_, error)| &error.message).collect::<Vec<_>>());
    let ids: Vec<String> = catalog.snapshot().models_of(&provider).iter().map(|r| r.id.clone()).collect();
    assert!(ids.iter().any(|id| id == "composer-2.5"), "{ids:?}");
    assert!(
        matches!(catalog.snapshot().status.get(&provider), Some(crate::catalog::ProviderStatus::Stale { .. })),
        "the static list is recorded as the account's answer"
    );
}

/// Hands out `first`, and `renewed` once a refusal of it is reported.
struct Renewing {
    renewals: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl AccessToken for Renewing {
    async fn access_token(&self) -> Result<Access, ProviderError> {
        Ok(Access::plain("first-cursor-token".to_owned()))
    }
    async fn after_rejection(&self, _rejected: &Access) -> Result<Access, ProviderError> {
        self.renewals.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Access::plain("renewed-cursor-token".to_owned()))
    }
    async fn renewed(&self) -> Result<Access, ProviderError> {
        self.access_token().await
    }
}

fn bearer(request: &WireRequest) -> &str {
    request.headers.iter().find(|(name, _)| name == "authorization").map_or("", |(_, value)| value.as_str())
}

/// A listing whose sign-in is refused and renewed lists again on the renewed token: the account's own models are what the
/// catalog records, not the static list.
#[tokio::test(start_paused = true)]
async fn a_refused_listing_whose_sign_in_is_renewed_lists_the_accounts_models() {
    let http = Arc::new(Replay::new(|request: &WireRequest| {
        if bearer(request) == "Bearer first-cursor-token" {
            (401, Vec::new())
        } else if request.url.ends_with("/GetUsableModels") {
            (200, vec![0x0A, 0x0F, 0x0A, 0x02, b'm', b'1', 0x22, 0x09, b'M', b'o', b'd', b'e', b'l', b' ', b'O', b'n', b'e'])
        } else {
            (200, Vec::new())
        }
    }));
    let tokens = Arc::new(Renewing { renewals: Default::default() });
    let adapter = CursorAdapter::new("cursor-oauth", None, Some(CLIENT_VERSION_FLOOR.into()), http, Arc::new(NoRun), tokens.clone());
    let provider = mixdog_protocol::ProviderId::from("cursor-oauth");
    let source = crate::catalog::ModelSource::of_adapter(provider.clone(), Arc::new(adapter)).expect("Cursor lists models");
    let catalog = crate::catalog::ProviderCatalog::new(crate::catalog::CatalogSnapshot::default());
    catalog.refresh(&[source]).await;
    let ids: Vec<String> = catalog.snapshot().models_of(&provider).iter().map(|r| r.id.clone()).collect();
    assert!(ids.iter().any(|id| id == "m1"), "{ids:?}");
    assert_eq!(catalog.snapshot().status.get(&provider), Some(&crate::catalog::ProviderStatus::Ok));
    assert_eq!(tokens.renewals.load(std::sync::atomic::Ordering::SeqCst), 1);
}

/// A sign-in marked for a new sign-in answers the static list as a settled answer: the catalog holds no retry time for
/// it, since nothing can change until the user signs in again.
#[tokio::test]
async fn a_signed_out_account_settles_with_the_static_list() {
    struct Marked;
    #[async_trait]
    impl AccessToken for Marked {
        async fn access_token(&self) -> Result<Access, ProviderError> {
            let mut error = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Auth, mixdog_core_api::domain::provider::DeliveryState::NotSent);
            error.reauth_required = true;
            error.status = Some(401);
            Err(error)
        }
        async fn after_rejection(&self, _rejected: &Access) -> Result<Access, ProviderError> {
            self.access_token().await
        }
        async fn renewed(&self) -> Result<Access, ProviderError> {
            self.access_token().await
        }
    }
    let http = Arc::new(Replay::new(|_request: &WireRequest| (200, Vec::new())));
    let adapter = CursorAdapter::new("cursor-oauth", None, Some(CLIENT_VERSION_FLOOR.into()), http.clone(), Arc::new(NoRun), Arc::new(Marked));
    let provider = mixdog_protocol::ProviderId::from("cursor-oauth");
    let source = crate::catalog::ModelSource::of_adapter(provider.clone(), Arc::new(adapter)).expect("Cursor lists models");
    let catalog = crate::catalog::ProviderCatalog::new(crate::catalog::CatalogSnapshot::default());
    catalog.refresh(&[source]).await;
    let snapshot = catalog.snapshot();
    assert!(snapshot.models_of(&provider).iter().any(|r| r.id == "composer-2.5"));
    assert_eq!(snapshot.status.get(&provider), Some(&crate::catalog::ProviderStatus::Ok));
    assert!(snapshot.complete() && snapshot.retry_at().is_none(), "a signed-out account keeps the catalog pending");
    assert!(http.requests.lock().unwrap().is_empty());
}

/// Two processes share the sign-in file. This one's listing is refused; the other renews the pair meanwhile, so this one's
/// renewal with the old refresh token is refused too and marks nothing. That is no settled answer: the static list is
/// asked again after the backoff, and the next ask lists the account's models on the pair the other process stored.
#[tokio::test]
#[allow(clippy::disallowed_methods, reason = "test: the other process writes the shared credential file")]
async fn a_renewal_refused_after_another_process_renewed_is_asked_again() {
    use base64::Engine;
    let jwt = |name: &str| {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":4000000000,"sub":"{name}"}}"#));
        format!("h.{payload}.s")
    };
    let (first, other) = (jwt("first"), jwt("other"));
    let pair =
        |access: &str, refresh: &str| serde_json::json!({ "access_token": access, "refresh_token": refresh, "expires_at": 4_000_000_000_000_u64 }).to_string();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cursor-oauth.json");
    std::fs::write(&path, pair(&first, "first-refresh")).unwrap();
    let (written, refused, renewed) = (path.clone(), format!("Bearer {first}"), format!("Bearer {other}"));
    let stored_by_other = pair(&other, "other-refresh");
    let http = Arc::new(Replay::new(move |request: &WireRequest| {
        if request.url == super::auth::EXCHANGE_URL {
            // The other process renewed first: the old refresh token is spent.
            std::fs::write(&written, &stored_by_other).unwrap();
            (401, Vec::new())
        } else if bearer(request) == refused {
            (401, Vec::new())
        } else if bearer(request) == renewed && request.url.ends_with("/GetUsableModels") {
            (200, vec![0x0A, 0x0F, 0x0A, 0x02, b'm', b'1', 0x22, 0x09, b'M', b'o', b'd', b'e', b'l', b' ', b'O', b'n', b'e'])
        } else {
            (200, Vec::new())
        }
    }));
    let rt = mixdog_rt::testing::tokens();
    let file = crate::oauth::CredentialFile::new(path.clone(), crate::oauth::CredentialIo { read: rt.interactive_io, write: rt.durability_io });
    let tokens = Arc::new(super::auth::FileAccess::new(http.clone(), file));
    let adapter = CursorAdapter::new("cursor-oauth", None, Some(CLIENT_VERSION_FLOOR.into()), http, Arc::new(NoRun), tokens);
    let provider = mixdog_protocol::ProviderId::from("cursor-oauth");
    let source = crate::catalog::ModelSource::of_adapter(provider.clone(), Arc::new(adapter)).expect("Cursor lists models");
    let catalog = crate::catalog::ProviderCatalog::new(crate::catalog::CatalogSnapshot::default());

    catalog.refresh(std::slice::from_ref(&source)).await;
    let snapshot = catalog.snapshot();
    assert!(matches!(snapshot.status.get(&provider), Some(crate::catalog::ProviderStatus::Stale { .. })), "{:?}", snapshot.status);
    assert!(snapshot.retry_at().is_some(), "the refused renewal settled the static list");
    assert!(!std::fs::read_to_string(&path).unwrap().contains("reauth_required\":true"), "the other process's sign-in was marked");

    catalog.refresh(&[source]).await;
    assert!(catalog.snapshot().models_of(&provider).iter().any(|r| r.id == "m1"), "the next ask lists the account's models");
    assert_eq!(catalog.snapshot().status.get(&provider), Some(&crate::catalog::ProviderStatus::Ok));
}

/// A 403 of the primary call and a 401 of the legacy one are not a refusal of the sign-in: nothing is renewed or marked,
/// and the listing goes on as for any failure.
#[tokio::test(start_paused = true)]
async fn only_a_401_of_the_primary_call_refuses_the_sign_in() {
    let http = Arc::new(Replay::new(|request: &WireRequest| if request.url.ends_with("/GetUsableModels") { (401, Vec::new()) } else { (403, Vec::new()) }));
    let tokens = Arc::new(Renewing { renewals: Default::default() });
    let adapter = CursorAdapter::new("cursor-oauth", None, Some(CLIENT_VERSION_FLOOR.into()), http.clone(), Arc::new(NoRun), tokens.clone());
    let records = adapter.models().unwrap().list_models().await.unwrap();
    assert!(records.iter().any(|r| r.id == "composer-2.5"), "the static list answers");
    assert_eq!(tokens.renewals.load(std::sync::atomic::Ordering::SeqCst), 0, "a failure that is not a 401 renewed the sign-in");
    assert_eq!(http.requests.lock().unwrap().len(), 8, "every attempt of the ladder was made");
}

/// The request reads text and base64 images only, so the route declares it takes no document and the attachments of any
/// other kind are lowered to text before the request is built, instead of vanishing.
#[test]
fn the_route_takes_no_document_so_attachments_are_lowered_to_text() {
    let (_, adapter) = adapter(Vec::new());
    assert_eq!((adapter.native_pdf(), adapter.native_documents()), (false, Some(false)));
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

/// A throttle that ends a run before any token, on a conversation an earlier run completed on, gives the retry a
/// fresh conversation id, once per streak of failures; the scope's record goes when the scope ends.
#[tokio::test]
async fn a_streamed_throttle_rotates_the_next_conversation_and_a_released_scope_forgets_it() {
    mixdog_rt::testing::tokens();
    let (_http, adapter) = adapter(Vec::new());
    let derived = adapter.conversation_of("s1");
    assert_eq!(adapter.conversation_of("s1"), derived);
    let live = || super::open_run::Live {
        body: Box::new(NoBody),
        sink: Arc::new(Silent),
        decoder: super::decoder::CursorDecoder::new(Default::default(), Vec::new(), None),
        heartbeat_at: std::time::Instant::now(),
        secret: "t".into(),
        fingerprint: super::open_run::Fingerprint {
            selection: super::request::ModelSelection { model_id: "m".into(), parameters: Vec::new(), max_mode: false, pricing_model: None },
            tools: Vec::new(),
            cloud_rule: None,
        },
    };
    let request =
        Arc::new(mixdog_core_api::domain::provider::ModelRequest { model: "m".into(), messages: Vec::new(), tools: Vec::new(), options: Default::default() });
    // A run of the scope ends with a throttle, after `tokens` streamed tokens.
    let throttled = |tokens: u64| {
        use crate::providers::connect::pb::Writer;
        let mut live = live();
        if tokens > 0 {
            let (mut delta, mut update, mut message) = (Writer::new(), Writer::new(), Writer::new());
            delta.varint(1, tokens);
            update.message(8, delta);
            message.message(1, update);
            mixdog_core_api::domain::provider::WireDecoder::feed(&mut live.decoder, &crate::providers::connect::frame::encode(&message.finish(), 0))
                .expect("decodes");
        }
        let mut stream = super::CursorStream::new(live, Default::default(), &request);
        stream.throttle = Some((adapter.rotated.clone(), "s1".into()));
        let mut throttle =
            ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::RateLimited, mixdog_core_api::domain::provider::DeliveryState::Accepted);
        throttle.status = Some(429);
        stream.fail(throttle);
    };
    throttled(0);
    assert_eq!(adapter.conversation_of("s1"), derived, "a conversation no run completed on is not one the service holds: its refusal stands");
    adapter.rotated.held("s1");
    throttled(5);
    assert_eq!(adapter.conversation_of("s1"), derived, "a throttle after tokens is of the account, not of the conversation");
    throttled(0);
    let retry = adapter.conversation_of("s1");
    assert_ne!(retry, derived, "the retry after a streamed throttle sends a fresh conversation id");
    throttled(0);
    assert_eq!(adapter.conversation_of("s1"), retry, "the fresh id's refusal stands: one new id per streak of failures");
    adapter.rotated.held("s1");
    throttled(0);
    assert_ne!(adapter.conversation_of("s1"), retry, "a run completed on it, so the next streak has its own");
    adapter.release_session("s1");
    assert_eq!(adapter.conversation_of("s1"), derived, "a scope that ended is forgotten");
}

/// A throttle that refuses the open: a first request's is the service's verdict and keeps the conversation; on a
/// conversation a run completed on, the retry runs under a fresh id, and that id's refusal stands.
#[tokio::test(start_paused = true)]
async fn a_throttled_conversation_is_retried_under_a_fresh_id() {
    struct Throttled(std::sync::Mutex<Vec<Vec<u8>>>);

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
    // The conversation id each refused request carried, read off the request itself.
    let sent = |request: Arc<mixdog_core_api::domain::provider::ModelRequest>| async {
        let error = adapter.attempt(request).await.err().expect("throttled");
        assert_eq!(error.status, Some(429));
        let body = runs.0.lock().unwrap().last().expect("a request").clone();
        let field = |bytes: &[u8], wanted: u32| {
            let mut reader = crate::providers::connect::pb::Reader::new(bytes);
            std::iter::from_fn(|| reader.next_field().ok().flatten()).find(|(n, _)| *n == wanted).map(|(_, v)| v.bytes().to_vec()).expect("the field")
        };
        String::from_utf8(field(&field(&body[5..], 1), 5)).expect("an id")
    };
    let derived = super::request::conversation_id("s1");
    assert_eq!(sent(request.clone()).await, derived);
    assert_eq!(sent(request.clone()).await, derived, "a first request's refusal is the service's verdict: the same conversation is asked again");

    // The process starts with the conversation under way: the transcript holds a turn of the assistant, and the
    // service holds the conversation as surely as after a run completed here.
    let mut under_way = (*request).clone();
    under_way.options.session_id = Some("s2".into());
    under_way.messages = ["hi", "hello", "again"]
        .iter()
        .enumerate()
        .map(|(at, text)| {
            let role = if at == 1 { mixdog_core_api::domain::provider::Role::Assistant } else { mixdog_core_api::domain::provider::Role::User };
            mixdog_core_api::domain::provider::Message::new(role, mixdog_core_api::domain::provider::Content::Text((*text).into()))
        })
        .collect();
    let under_way = Arc::new(under_way);
    let derived = super::request::conversation_id("s2");
    assert_eq!(sent(under_way.clone()).await, derived, "the request that is refused");
    let fresh = sent(under_way.clone()).await;
    assert_ne!(fresh, derived, "the retry carries a fresh conversation id");
    assert_eq!(sent(under_way.clone()).await, fresh, "and the fresh id's refusal stands");
}

/// A run is asked with the tools this side offers and no tool of the service's own; a unary call names none.
#[test]
fn a_run_limits_the_service_to_the_tools_of_this_side() {
    let limit = |unary: bool| super::rpc_headers("t", "1", unary).into_iter().find(|(name, _)| name == "x-cursor-agent-allowed-tools").map(|(_, value)| value);
    assert_eq!((limit(false).as_deref(), limit(true)), (Some("mcp_tool_call"), None));
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
