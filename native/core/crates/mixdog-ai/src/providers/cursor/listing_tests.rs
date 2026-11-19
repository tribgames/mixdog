//! Replays what Node's `listModels` recorded (`providers/cursor-models`): the
//! same `AvailableModels` answer must give the same rows, and the same
//! request must be sent.
#![cfg(test)]

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
#[cfg(node_twin)]
use serde_json::Value;

use super::AccessToken;
use super::CLIENT_VERSION_FLOOR;
use super::CursorAdapter;
#[cfg(node_twin)]
use super::models::ParameterAsk;
#[cfg(node_twin)]
use super::models::decode_available_models;
#[cfg(node_twin)]
use super::models::resolve_selection;
use crate::providers::listing_row::testing::Replay;
#[cfg(node_twin)]
use crate::providers::listing_row::testing::fixture;
#[cfg(node_twin)]
use crate::providers::listing_row::testing::unhex;
use crate::transport::http::BidiOpen;
use crate::transport::http::FrameSink;
use crate::transport::http::HttpResponse;

struct Token;

#[async_trait]
impl AccessToken for Token {
    async fn access_token(&self, _force_refresh: bool) -> Result<String, ProviderError> {
        Ok("fixture-cursor-token".to_owned())
    }
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

/// What a turn sends for each requested id and ask equals what Node's
/// `_resolveCursorModel` sent: the parameterized variants, the aliases, and
/// the id-named variants chosen by suffix.
#[cfg(node_twin)]
#[test]
fn every_recorded_resolution_equals_nodes() {
    let recorded = fixture("cursor-models/cases.json");
    let mut checked = 0;
    for (name, case) in recorded["cases"].as_object().unwrap() {
        let Some(resolutions) = case.get("resolutions") else { continue };
        let catalog = decode_available_models(&unhex(case["response"].as_str().unwrap())).unwrap();
        for entry in resolutions.as_array().unwrap() {
            let ask = &entry["ask"];
            let route = ask.get("modelParameters").and_then(Value::as_object);
            let got = resolve_selection(
                &catalog,
                entry["model"].as_str().unwrap(),
                &ParameterAsk {
                    effort: ask["effort"].as_str(),
                    fast: ask["fast"].as_bool().unwrap_or(false),
                    route,
                    selected_context_window: ask["selectedContextWindow"].as_u64(),
                },
            );
            let label = format!("{name}: {} {ask}", entry["model"]);
            match (got, entry.get("ok")) {
                (Ok(got), Some(want)) => {
                    assert_eq!(got.model_id, want["modelId"].as_str().unwrap(), "{label}");
                    let parameters: Vec<Value> =
                        got.parameters.iter().map(|(id, value)| serde_json::json!({"id": id, "value": value})).collect();
                    assert_eq!(Value::Array(parameters), want["parameters"], "{label}");
                    assert_eq!(got.max_mode, want["maxMode"].as_bool().unwrap_or(false), "{label}");
                }
                (Err(got), None) => assert_eq!(got.message, entry["error"].as_str().unwrap(), "{label}"),
                (got, _) => panic!("{label}: Rust {got:?}, Node {entry}"),
            }
            checked += 1;
        }
    }
    assert!(checked > 500, "the recording has the resolutions ({checked})");
}

/// What a turn sends equals Node's: the model on the chat body and the
/// `pricingModel` a pinned suffix id bills as, including `auto` against a
/// server that lists no Auto (Node sends `auto` for it).
#[cfg(node_twin)]
#[test]
fn every_recorded_send_has_nodes_model_and_pricing_model() {
    let recorded = fixture("cursor-models/cases.json");
    let mut checked = 0;
    for (name, case) in recorded["cases"].as_object().unwrap() {
        let Some(sends) = case.get("sends") else { continue };
        let catalog = decode_available_models(&unhex(case["response"].as_str().unwrap())).unwrap();
        for entry in sends.as_array().unwrap() {
            let model = entry["model"].as_str().unwrap();
            let got = resolve_selection(
                &catalog,
                model,
                &ParameterAsk { effort: entry["ask"]["effort"].as_str(), ..ParameterAsk::default() },
            );
            match (got, entry.get("ok")) {
                (Ok(got), Some(want)) => {
                    assert_eq!(got.model_id, want["sentModel"].as_str().unwrap(), "{name}: {model}");
                    assert_eq!(got.pricing_model.as_deref(), want["pricingModel"].as_str(), "{name}: {model}");
                }
                (Err(got), None) => assert_eq!(got.message, entry["error"].as_str().unwrap(), "{name}: {model}"),
                (got, _) => panic!("{name}: {model}: Rust {got:?}, Node {entry}"),
            }
            checked += 1;
        }
    }
    assert!(checked > 150, "the recording has the sends ({checked})");
}

#[cfg(node_twin)]
#[test]
fn a_server_without_auto_still_lists_it_first() {
    let recorded = fixture("cursor-models/cases.json");
    let case = &recorded["cases"]["no-auto-bare"];
    let catalog = decode_available_models(&unhex(case["response"].as_str().unwrap())).unwrap();
    assert!(catalog.iter().any(|m| m.id == "auto" && m.name == "Auto"));
    let auto = case["expected"].as_array().unwrap().iter().find(|row| row["id"] == "auto").expect("Node lists Auto");
    assert_eq!(auto["display"], "Auto");
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
    let mut stream = super::CursorStream::new(Box::new(NoBody), Arc::new(Silent), super::decoder::CursorDecoder::new(Default::default(), Vec::new(), None), "t".into());
    stream.throttle = Some((adapter.rotated.clone(), "s1".into()));
    let mut throttle = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::RateLimited, mixdog_core_api::domain::provider::DeliveryState::Accepted);
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
#[cfg(node_twin)]
#[tokio::test]
async fn every_recorded_case_gives_node_rows_and_request() {
    let recorded = fixture("cursor-models/cases.json");
    for (name, case) in recorded["cases"].as_object().unwrap() {
        let (http, adapter) = adapter(unhex(case["response"].as_str().unwrap()));
        let records = adapter.models().expect("cursor lists models").list_models().await.unwrap();

        let sent = http.requests.lock().unwrap().clone();
        let want = &case["requests"][0];
        assert_eq!(sent.len(), 1, "{name}");
        assert_eq!(sent[0].method, want["method"].as_str().unwrap());
        assert!(sent[0].url.ends_with(want["path"].as_str().unwrap()), "{name}: {}", sent[0].url);
        assert_eq!(sent[0].body, unhex(want["body"].as_str().unwrap()), "{name}");
        // Every header Node sent, with the same value; the request id is fresh.
        for (key, value) in want["headers"].as_object().unwrap() {
            let sent_value = sent[0].headers.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
            assert_eq!(sent_value, value.as_str(), "{name}: {key}");
        }
        assert!(sent[0].headers.iter().any(|(k, _)| k == "x-request-id"));

        let expected = case["expected"].as_array().unwrap();
        assert_eq!(records.len(), expected.len(), "{name}");
        for (record, row) in records.iter().zip(expected) {
            assert_eq!(record.raw.as_ref(), Some(row), "{name}: {}", row["id"]);
            crate::providers::listing_row::testing::assert_row_facts(record, row, &format!("{name}: {}", row["id"]));
            assert_eq!(record.id, row["id"].as_str().unwrap());
            assert_eq!(record.display_name.as_deref(), row["display"].as_str());
            assert_eq!(record.context_window, row["contextWindow"].as_u64());
            assert_eq!(record.supports_reasoning, row["supportsReasoning"].as_bool());
            assert_eq!(record.supports_images, row["supportsVision"].as_bool());
            assert_eq!(record.mode.as_deref(), Some("chat"));
            assert_eq!(record.default_reasoning_level.as_deref(), row["defaultEffort"].as_str());
            let strings = |key: &str| -> Vec<String> {
                row[key].as_array().into_iter().flatten().map(|v| v.as_str().unwrap().to_owned()).collect()
            };
            assert_eq!(record.reasoning_levels, strings("reasoningLevels"));
            // The picker fields: fast efforts, parameter options and each variant's route.
            assert_eq!(record.picker.fast_efforts, strings("fastEfforts"));
            assert_eq!(
                serde_json::to_value(&record.picker.model_parameter_options).unwrap(),
                row.get("modelParameterOptions").cloned().unwrap_or_else(|| serde_json::json!([])),
                "{name}: {}",
                row["id"]
            );
            assert_eq!(
                serde_json::to_value(&record.picker.parameter_variants).unwrap(),
                row.get("parameterVariants").cloned().unwrap_or_else(|| serde_json::json!([])),
                "{name}: {}",
                row["id"]
            );
            let ladder: Vec<Value> = row["reasoningOptions"].as_array().cloned().unwrap_or_default();
            assert_eq!(serde_json::to_value(&record.picker.reasoning_options).unwrap(), Value::Array(ladder));
        }
    }
}
