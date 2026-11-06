//! `resolveSessionContextMeta(provider, model, seed, { wholeWindow })` (`context-meta.mjs`): the
//! window a session starts with on a model. The provider's cached row is the catalog's listed row
//! of the model (`getCachedModelInfo`), the model's metadata is `CatalogService::sync_meta`
//! (`getModelMetadataSync`) and the default-window rule is `admin_route::context_window_range`.
//!
//! A cold catalog falls back to [`guess_context_window`] (`guessContextWindow`). A managed local
//! runtime's `runtimeContextWindow` (its allocated capacity) bounds the selected window.

use mixdog_ai::catalog::CatalogService;
use mixdog_ai::service::admin_route::context_window_range;
use mixdog_js::{json_number, to_number_of};
use mixdog_protocol::ProviderId;
use serde_json::{Map, Value};

/// `resolveSessionContextMeta(provider, model, seed)`: the five window fields of a model, as the
/// header stores them (`null` where the model states none).
#[derive(Clone, PartialEq, Debug)]
pub struct ContextMeta {
    pub context_window: Value,
    pub raw_context_window: Value,
    pub effective_context_window_percent: Value,
    pub auto_compact_token_limit: Value,
    pub compact_boundary_tokens: Value,
}


type Obj = Map<String, Value>;

/// The session boundary is the model's full raw window; headroom is the compact policy's.
const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT: f64 = 100.0;

/// `guessContextWindow(model, provider)`: the family fallback used when the provider and the
/// external catalogs both miss.
pub fn guess_context_window(model: &str, provider: &str) -> f64 {
    let m = model.to_lowercase();
    let p = provider.to_lowercase();
    let local_provider = matches!(p.as_str(), "mixdog-local" | "local" | "");
    // Cursor's backend defaults to the standard tier until its live catalog has warmed.
    if (p == "cursor-oauth" || p == "cursor-api") && !m.is_empty() {
        return 200_000.0;
    }
    let local_family = ["llama", "mistral", "mixtral", "phi", "qwen", "gemma", "deepseek-r1", "codellama"];
    if local_provider && local_family.iter().any(|family| m.contains(family)) {
        return 8192.0;
    }
    let opus_class = ["opus", "sonnet", "fable"].iter().any(|kind| m.strip_prefix("claude-").is_some_and(|rest| rest.starts_with(kind)));
    if opus_class {
        return 1_000_000.0;
    }
    if m.starts_with("claude-") {
        return 200_000.0;
    }
    if m.starts_with("gemini-3") || m.starts_with("gemini-2") {
        return 1_000_000.0;
    }
    if m.starts_with("gpt-5") || m.starts_with("gpt-6") {
        return 272_000.0;
    }
    if m.starts_with("grok-build") {
        return 256_000.0;
    }
    if m.starts_with("grok-") {
        return 500_000.0;
    }
    if m.starts_with("deepseek-v") {
        return 1_000_000.0;
    }
    128_000.0
}

/// `positiveInt(value)`.
fn positive_int(value: Option<&Value>) -> Option<f64> {
    let parsed = to_number_of(value).floor();
    (parsed.is_finite() && parsed >= 1.0).then_some(parsed)
}

fn field<'a>(row: Option<&'a Obj>, key: &str) -> Option<&'a Value> {
    row.and_then(|r| r.get(key))
}

/// The first of `candidates` that is neither missing nor null: JavaScript's `??` chain.
fn first_stated<'a>(candidates: &[Option<&'a Value>]) -> Option<&'a Value> {
    candidates.iter().copied().flatten().find(|v| !v.is_null())
}

/// `boundedPercent(value, fallback)`.
fn bounded_percent(value: Option<&Value>, fallback: Option<f64>) -> Option<f64> {
    let n = to_number_of(value);
    if n.is_finite() && n > 0.0 && n <= 100.0 { Some(n) } else { fallback }
}

/// `providerRawContextWindow(info, catalogInfo)`: live API fields outrank the catalog, which
/// outranks a stale cached snapshot.
fn provider_raw_window(info: Option<&Obj>, catalog: Option<&Obj>) -> Option<f64> {
    let info = info?;
    let first = |row: Option<&Obj>, keys: &[&str]| keys.iter().find_map(|k| positive_int(field(row, k)));
    if let Some(api) = first(Some(info), &["context_window", "max_context_window"]) {
        return Some(api);
    }
    let cached = first(Some(info), &["contextWindow", "maxContextWindow"]);
    let catalog_window = first(catalog, &["contextWindow", "maxContextWindow", "context_window", "max_context_window"]);
    match catalog_window {
        Some(window) if cached != Some(window) => Some(window),
        _ => cached,
    }
}

/// The resolution itself, over the two rows Node reads.
pub fn resolve_context_meta(info: Option<&Obj>, catalog: Option<&Obj>, provider: &str, model: &str, seed: &Value, whole_window: bool) -> ContextMeta {
    let seed = seed.as_object();
    let seed_field = |key: &str| seed.and_then(|s| s.get(key));
    let provider = provider.to_lowercase();
    let served = provider_raw_window(info, catalog)
        .or_else(|| ["contextWindow", "maxContextWindow", "context_window", "max_context_window"].iter().find_map(|k| positive_int(field(catalog, k))))
        .or_else(|| positive_int(seed_field("rawContextWindow")))
        .or_else(|| positive_int(seed_field("raw_context_window")))
        .or_else(|| positive_int(seed_field("contextWindow")))
        .unwrap_or_else(|| guess_context_window(model, &provider));
    // A session that records no selection starts from the model's default window, the one the
    // picker shows; a recorded percentage keeps the served window.
    let records_selection = whole_window || bounded_percent(seed_field("contextPercent"), None).is_some();
    let selected_tokens = positive_int(seed_field("contextTokens"));
    let requested = positive_int(seed_field("selectedContextWindow"))
        .or_else(|| selected_tokens.map(|tokens| tokens.min(served)))
        .unwrap_or_else(|| {
            if records_selection {
                served
            } else {
                context_window_range(&provider, Some(&json_number(served)), None).0
            }
        });
    let raw = match positive_int(field(info, "runtimeContextWindow")) {
        Some(runtime) => requested.min(runtime),
        None => requested,
    };
    let percent_value = first_stated(&[
        seed_field("effectiveContextWindowPercent"),
        seed_field("effective_context_window_percent"),
        field(info, "effectiveContextWindowPercent"),
        field(info, "effective_context_window_percent"),
        field(catalog, "effectiveContextWindowPercent"),
        field(catalog, "effective_context_window_percent"),
    ]);
    let percent = bounded_percent(percent_value, Some(DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT)).unwrap_or(DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT);
    let boundary = (raw * percent / 100.0).floor().max(1.0);
    let limit_value = first_stated(&[
        seed_field("autoCompactTokenLimit"),
        seed_field("auto_compact_token_limit"),
        field(info, "autoCompactTokenLimit"),
        field(info, "auto_compact_token_limit"),
        field(catalog, "autoCompactTokenLimit"),
        field(catalog, "auto_compact_token_limit"),
    ]);
    // A limit at or above the boundary is a derived full-window artifact of older sessions; only
    // an explicit one strictly below it is kept.
    let limit = positive_int(limit_value).filter(|limit| *limit < boundary);
    ContextMeta {
        context_window: json_number(boundary),
        raw_context_window: json_number(raw),
        effective_context_window_percent: json_number(percent),
        auto_compact_token_limit: limit.map_or(Value::Null, json_number),
        compact_boundary_tokens: json_number(boundary),
    }
}

/// The provider's cached row of `model` (`getCachedModelInfo`): what the catalog lists for it.
fn cached_row(catalog: &CatalogService, provider: &str, model: &str) -> Option<Obj> {
    let snapshot = catalog.snapshot();
    let record = snapshot.models_of(&ProviderId::from(provider)).iter().find(|r| r.id == model)?;
    let mut row = Obj::new();
    for (key, window) in [
        ("contextWindow", record.context_window),
        ("maxContextWindow", record.max_context_window),
        ("runtimeContextWindow", record.runtime_context_window),
    ] {
        if let Some(window) = window {
            row.insert(key.into(), Value::from(window));
        }
    }
    Some(row)
}

/// `resolveSessionContextMeta(provider, model, seed, { wholeWindow })`. `None` when the provider or
/// the model is empty, as the route change skips both.
pub fn session_context_meta_with(catalog: &CatalogService, provider: &str, model: &str, seed: &Value, whole_window: bool) -> Option<ContextMeta> {
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let name = provider.to_lowercase();
    let info = cached_row(catalog, provider, model);
    let meta = catalog.sync_meta(model, &name);
    Some(resolve_context_meta(info.as_ref(), meta.as_ref(), provider, model, seed, whole_window))
}

/// `resolveSessionContextMeta(provider, model, seed)`: the window a session starts with.
pub fn session_context_meta(catalog: &CatalogService, provider: &str, model: &str, seed: &Value) -> Option<ContextMeta> {
    session_context_meta_with(catalog, provider, model, seed, false)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use mixdog_ai::catalog::{CatalogSnapshot, ModelsDevSource};
    use mixdog_ai::oauth::CredentialIo;
    use mixdog_ai::transport::http::{HttpResponse, HttpSend};
    use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, WireRequest};
    use serde_json::json;

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!("golden/session_context_meta.json")).expect("fixture")
    }

    fn fields(meta: &ContextMeta) -> Value {
        json!({
            "contextWindow": meta.context_window, "rawContextWindow": meta.raw_context_window,
            "effectiveContextWindowPercent": meta.effective_context_window_percent,
            "autoCompactTokenLimit": meta.auto_compact_token_limit, "compactBoundaryTokens": meta.compact_boundary_tokens,
        })
    }

    /// Every recorded case equals Node's answer, given the cached row and the catalog row Node read.
    #[test]
    fn every_window_equals_nodes() {
        let golden = golden();
        let cases = golden["cases"].as_array().expect("cases");
        assert!(cases.len() > 800);
        for case in cases {
            let row = |key: &str| case[key].as_object().cloned();
            let got = resolve_context_meta(row("info").as_ref(), row("catalogInfo").as_ref(), case["provider"].as_str().unwrap(), case["model"].as_str().unwrap(), &case["seed"], case["wholeWindow"].as_bool().unwrap());
            assert_eq!(fields(&got), case["meta"], "{case}");
        }
    }

    struct Offline;

    #[async_trait]
    impl HttpSend for Offline {
        async fn send(&self, _: WireRequest) -> Result<HttpResponse, ProviderError> {
            Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
        }
    }

    /// A cold catalog reads the same as Node's cold catalog: the cases Node answered with no
    /// provider row are the ones Rust answers from `CatalogService`.
    #[tokio::test]
    async fn a_cold_catalog_answers_as_nodes_does() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
        let catalog = CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await;
        let golden = golden();
        let mut checked = 0;
        for case in golden["cases"].as_array().unwrap().iter().filter(|c| c["info"].is_null() && !c["provider"].as_str().unwrap().is_empty()) {
            let (provider, model) = (case["provider"].as_str().unwrap(), case["model"].as_str().unwrap());
            let got = session_context_meta_with(&catalog, provider, model, &case["seed"], case["wholeWindow"].as_bool().unwrap()).expect("meta");
            assert_eq!(fields(&got), case["meta"], "{case}");
            checked += 1;
        }
        assert!(checked > 200);
        assert!(session_context_meta(&catalog, "", "m", &json!({})).is_none());
    }

    #[test]
    fn the_catalog_outranks_a_stale_cached_window_and_a_live_field_outranks_both() {
        let row = |value: Value| value.as_object().cloned();
        let pick = |info: Option<Obj>, catalog: Option<Obj>| resolve_context_meta(info.as_ref(), catalog.as_ref(), "anthropic", "claude-opus-4-8", &json!({}), true).raw_context_window;
        assert_eq!(pick(row(json!({ "contextWindow": 272000 })), row(json!({ "contextWindow": 1000000 }))), 1_000_000);
        assert_eq!(pick(row(json!({ "context_window": 2000000, "contextWindow": 272000 })), row(json!({ "contextWindow": 1000000 }))), 2_000_000);
        assert_eq!(pick(None, row(json!({ "maxContextWindow": 640000 }))), 640_000);
        assert_eq!(pick(None, None), 1_000_000);
    }
}
