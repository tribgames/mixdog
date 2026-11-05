//! Model facts the route layer asks the catalog for, Node-shaped:
//! `lookupModelMeta` (`provider-models/model-meta.mjs`), `getModelMetadataSync`
//! truthiness, `fastCapableFor` / `ultrafastCapableFor`
//! (`runtime-core/model-capabilities.mjs`), `openAiDirectSupportsFast` /
//! `Ultrafast`, `supportsAnthropicFastMode`, `modelSupportsServiceTier` and
//! `cachedRouteWindows` (`runtime-core/route-context-state.mjs`).
//!
//! Every read is one load of the resident snapshot; none refreshes. The rows
//! come from the Rust catalog, so a fact the catalog record does not carry
//! (the `fastPricing` / `ultrafastPricing` rate columns) is absent, and the
//! documented-id fallback decides, exactly as for a row silent on it.

use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use super::record::Capability;
use super::record::ModelRecord;
use super::lookup::enrich_model;
use super::record::Thinking;
use super::lookup::Obj;
use super::rosters::CachedWindows;
use super::service::CatalogService;
use crate::service::admin_route::clean;
use crate::service::admin_route::truthy;

const FAST_CAPABLE_PROVIDERS: [&str; 6] =
    ["anthropic", "anthropic-oauth", "openai", "openai-oauth", "cursor-oauth", "cursor-api"];

fn flag(c: Capability) -> Option<bool> {
    match c {
        Capability::Yes => Some(true),
        Capability::No => Some(false),
        Capability::Unknown => None,
    }
}

/// A catalog record as the row `lookupModelMeta` hands the route layer: the
/// fields it states, camelCase, undeclared ones left out.
fn row_of(record: &ModelRecord) -> Value {
    let mut row = serde_json::Map::new();
    row.insert("id".into(), json!(record.id));
    row.insert("provider".into(), json!(record.provider.as_str()));
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            row.insert(key.into(), value);
        }
    };
    put("displayName", record.display_name.as_ref().map(|v| json!(v)));
    put("family", record.family.as_ref().map(|v| json!(v)));
    put("contextWindow", record.context_window.map(|v| json!(v)));
    put("outputTokens", record.output_tokens.map(|v| json!(v)));
    put("inputCostPerM", record.rates.input.map(|v| json!(v)));
    put("outputCostPerM", record.rates.output.map(|v| json!(v)));
    put("cacheReadCostPerM", record.rates.cache_read.map(|v| json!(v)));
    put("cacheWriteCostPerM", record.rates.cache_write.map(|v| json!(v)));
    put("supportsVision", flag(record.vision).map(Value::Bool));
    put("supportsFunctionCalling", flag(record.function_calling).map(Value::Bool));
    put("supportsReasoning", flag(record.reasoning).map(Value::Bool));
    put("supportsFastMode", flag(record.fast_mode).map(Value::Bool));
    let levels: &[String] = if record.reasoning_efforts.is_empty() {
        match &record.thinking {
            Thinking::Levels(levels) => levels,
            _ => &[],
        }
    } else {
        &record.reasoning_efforts
    };
    if !levels.is_empty() {
        put("reasoningOptions", Some(json!([{"type": "effort", "values": levels}])));
    }
    Value::Object(row)
}

/// `String(model?.id || model || '').trim()` for a route row or a bare id.
fn model_id(model: &Value) -> String {
    let id = if truthy(model.get("id")) { model.get("id") } else { Some(model) };
    clean(id)
}

/// `modelSupportsServiceTier`: the tier is listed, an additional speed tier,
/// or the model's default.
fn supports_service_tier(model: &Value, tier: &str) -> bool {
    if tier.is_empty() || !model.is_object() {
        return false;
    }
    let listed = |key: &str| model.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    listed("serviceTiers").iter().any(|t| t.get("id").and_then(Value::as_str) == Some(tier))
        || listed("additionalSpeedTiers").iter().any(|t| t.as_str() == Some(tier))
        || model.get("defaultServiceTier").and_then(Value::as_str) == Some(tier)
}

fn digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit())
}

/// `(?:-\d{4}-\d{2}-\d{2})?$` over what follows a matched id prefix.
fn dated_or_end(rest: &str) -> bool {
    let mut parts = rest.split('-');
    rest.is_empty()
        || (parts.next() == Some("")
            && parts.next().is_some_and(|p| digits(p, 4))
            && parts.next().is_some_and(|p| digits(p, 2))
            && parts.next().is_some_and(|p| digits(p, 2))
            && parts.next().is_none())
}

/// `-\d{4}` right after an id prefix, or the end of the id.
fn year_or_end(rest: &str) -> bool {
    rest.is_empty() || rest.strip_prefix('-').is_some_and(|r| r.len() >= 4 && r.as_bytes()[..4].iter().all(u8::is_ascii_digit))
}

/// `PRE_CATALOG_GPT_56_PLUS` or `PRE_CATALOG_EARLIER_FAST`.
fn documented_fast(id: &str) -> bool {
    const PLUS: [&str; 7] =
        ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
    PLUS.iter().any(|base| id.strip_prefix(base).is_some_and(dated_or_end))
        || id
            .strip_prefix("gpt-5.")
            .is_some_and(|tail| ["5", "4", "4-mini"].iter().any(|v| tail.strip_prefix(v).is_some_and(year_or_end)))
}

/// `PRE_CATALOG_ULTRAFAST`.
fn documented_ultrafast(id: &str) -> bool {
    ["gpt-6-astra", "gpt-6.1-sol"].iter().any(|base| id.strip_prefix(base).is_some_and(dated_or_end))
}

/// `KNOWN_FAST_MODE_MODELS`: `^claude-opus-(?:4-8|5)(?:$|[-@])`.
fn known_anthropic_fast(id: &str) -> bool {
    id.strip_prefix("claude-opus-").is_some_and(|tail| {
        ["4-8", "5"]
            .iter()
            .any(|v| tail.strip_prefix(v).is_some_and(|r| r.is_empty() || r.starts_with(['-', '@'])))
    })
}

/// `SNAPSHOT_SUFFIX` removed: `-\d{4}-\d{2}-\d{2}$`.
fn without_snapshot(id: &str) -> &str {
    let Some(cut) = id.len().checked_sub(11) else { return id };
    match id.get(cut..) {
        Some(tail) if tail.starts_with('-') && dated_or_end(tail) => &id[..cut],
        _ => id,
    }
}

impl CatalogService {
    fn record_of<R>(&self, provider: &str, model: &str, read: impl FnOnce(&ModelRecord) -> R) -> Option<R> {
        let snapshot = self.snapshot();
        snapshot.models_of(&ProviderId::from(provider)).iter().find(|r| r.id == model).map(read)
    }

    /// `lookupModelMeta(provider, model)`: the provider's listed row for the
    /// model, enriched from the catalog layers (`enrichModels`), or the bare
    /// `{id, provider}` placeholder when the provider lists no such model.
    pub fn model_meta(&self, provider: &str, model: &str) -> Value {
        match self.record_of(provider, model, row_of) {
            Some(listed) => self.with_lookup(|lookup| enrich_model(lookup, &listed)),
            None => json!({"id": model, "provider": provider}),
        }
    }

    /// `getModelMetadataSync(id, provider)`: the merged catalog metadata.
    pub fn sync_meta(&self, id: &str, provider: &str) -> Option<Obj> {
        if id.is_empty() {
            return None;
        }
        self.with_lookup(|lookup| lookup.lookup(id, provider, None))
    }

    /// Whether the catalog has metadata for the model, which is what
    /// `set-route.mjs:57` asks (`getModelMetadataSync(model, provider)` is non-null).
    pub fn catalog_knows(&self, model: &str, provider: &str) -> bool {
        self.sync_meta(model, provider).is_some()
    }

    /// The `supportsFastMode` the catalog declares for `provider`'s model.
    fn declared_fast(&self, provider: &str, id: &str) -> Option<bool> {
        self.sync_meta(id, provider)?.get("supportsFastMode").and_then(Value::as_bool)
    }

    /// `openAiCatalogMeta(model)`: the metadata of the id, else of the id
    /// without a dated snapshot suffix.
    fn openai_catalog_meta(&self, id: &str) -> Option<Obj> {
        let mut candidates = vec![id];
        if without_snapshot(id) != id {
            candidates.push(without_snapshot(id));
        }
        candidates.into_iter().filter(|c| !c.is_empty()).find_map(|c| self.sync_meta(c, "openai"))
    }

    /// `openAiDirectSupportsFast`: the catalog's declaration decides, a
    /// published Priority rate is the same declaration, and a row silent on
    /// Fast keeps the documented ids.
    fn openai_direct_fast(&self, model: &Value) -> bool {
        let id = model_id(model);
        if let Some(meta) = self.openai_catalog_meta(&id) {
            if let Some(declared) = meta.get("supportsFastMode").and_then(Value::as_bool) {
                return declared;
            }
            if truthy(meta.get("fastPricing")) {
                return true;
            }
        }
        documented_fast(&id)
    }

    /// `fastCapableFor(provider, model, effort, modelParameters)`.
    pub fn fast_capable(&self, provider: &str, model: &Value, effort: Option<&str>, params: &Value) -> bool {
        let p = clean(Some(&Value::from(provider)));
        if !FAST_CAPABLE_PROVIDERS.contains(&p.as_str()) {
            return false;
        }
        if p == "cursor-oauth" || p == "cursor-api" {
            return cursor_fast(model, effort, params);
        }
        if p == "openai-oauth" {
            return supports_service_tier(model, "priority");
        }
        if let Some(own) = model.get("supportsFastMode").and_then(Value::as_bool) {
            return own;
        }
        let id = model_id(model);
        if let Some(declared) = self.declared_fast(&p, &id) {
            return declared;
        }
        match p.as_str() {
            "openai" => self.openai_direct_fast(model),
            _ => self.supports_anthropic_fast_mode(&id),
        }
    }

    /// `supportsAnthropicFastMode(model)`: the catalog's declaration decides;
    /// the id pattern is the offline floor for a model it says nothing about.
    pub fn supports_anthropic_fast_mode(&self, model: &str) -> bool {
        let id = model.to_lowercase().replace('.', "-");
        !id.is_empty() && self.declared_fast("anthropic", &id).unwrap_or_else(|| known_anthropic_fast(&id))
    }

    /// `ultrafastCapableFor(provider, model)`.
    pub fn ultrafast_capable(&self, provider: &str, model: &Value) -> bool {
        match clean(Some(&Value::from(provider))).as_str() {
            "openai" => {
                let id = model_id(model);
                self.openai_catalog_meta(&id).is_some_and(|m| truthy(m.get("ultrafastPricing"))) || documented_ultrafast(&id)
            }
            "openai-oauth" => supports_service_tier(model, "ultrafast"),
            _ => false,
        }
    }

    /// `cachedRouteWindows(provider, model)`: the windows the provider's
    /// persisted roster row states, from the roster snapshot of the last refresh.
    pub fn cached_windows(&self, provider: &str, model: &str) -> Option<CachedWindows> {
        self.rosters.load().windows(provider, model)
    }
}

/// The Cursor branch of `fastCapableFor`: fast variants by effort and parameters.
fn cursor_fast(model: &Value, effort: Option<&str>, params: &Value) -> bool {
    let fast_efforts: Vec<String> = model
        .get("fastEfforts")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|v| clean(Some(v))).collect())
        .unwrap_or_default();
    if model.get("fastCapable") != Some(&Value::Bool(true)) && fast_efforts.is_empty() {
        return false;
    }
    let selected = clean(effort.map(Value::from).as_ref());
    if let Some(variants) = model.get("parameterVariants").and_then(Value::as_array).filter(|v| !v.is_empty()) {
        let empty = serde_json::Map::new();
        let parameters = params.as_object().unwrap_or(&empty);
        return variants.iter().any(|variant| {
            variant.get("fast").and_then(Value::as_str) == Some("true")
                && (selected.is_empty()
                    || !truthy(variant.get("effort"))
                    || clean(variant.get("effort")) == selected)
                && parameters
                    .iter()
                    .all(|(key, value)| !truthy(variant.get(key)) || clean(variant.get(key)) == clean(Some(value)))
        });
    }
    selected.is_empty() || fast_efforts.is_empty() || fast_efforts.contains(&selected)
}

#[cfg(test)]
pub(super) mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::catalog::lookup;
    use crate::catalog::CatalogSnapshot;
    use crate::catalog::ModelsDevSource;

    pub(in crate::catalog) struct Offline;
    #[async_trait::async_trait]
    impl crate::transport::http::HttpSend for Offline {
        async fn send(
            &self,
            _: mixdog_core_api::domain::provider::WireRequest,
        ) -> Result<crate::transport::http::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
            Err(mixdog_core_api::domain::provider::ProviderError::new(
                mixdog_core_api::domain::provider::ErrorKind::Transient,
                mixdog_core_api::domain::provider::DeliveryState::NotSent,
            ))
        }
    }

    pub(in crate::catalog) fn io() -> crate::oauth::CredentialIo {
        let tokens = mixdog_rt::testing::tokens();
        crate::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
    }

    async fn service_in(dir: &std::path::Path, records: Vec<ModelRecord>) -> CatalogService {
        let mut snapshot = CatalogSnapshot::default();
        for record in records {
            snapshot.models.entry(record.provider.clone()).or_default().push(record);
        }
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), io());
        CatalogService::cold_start(snapshot, Vec::new(), metadata).await
    }

    async fn service(records: Vec<ModelRecord>) -> CatalogService {
        let dir = tempfile::tempdir().unwrap();
        service_in(dir.path(), records).await
    }

    /// A service whose overlays and rosters are the recorded Node fixtures.
    async fn golden_service(records: Vec<ModelRecord>) -> CatalogService {
        use crate::catalog::ModelsDev;
        let dir = tempfile::tempdir().unwrap();
        let mut snapshot = CatalogSnapshot::default();
        for record in records {
            snapshot.models.entry(record.provider.clone()).or_default().push(record);
        }
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io());
        metadata.set_layer(ModelsDev::from_models_dev(lookup::fixtures::json(lookup::fixtures::MODELS_DEV)).unwrap());
        let litellm = ModelsDevSource::litellm(Arc::new(Offline), dir.path().to_path_buf(), io());
        litellm.set_layer(ModelsDev::from_litellm(lookup::fixtures::json(lookup::fixtures::LITELLM)));
        let service = CatalogService::cold_start(snapshot, Vec::new(), metadata).await.with_litellm(litellm).await;
        service.rosters.store(Arc::new(lookup::fixtures::rosters()));
        service
    }

    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "fixture file")]
    async fn cached_windows_come_from_the_roster_files_read_at_start() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("openai-oauth-models.json"),
            r#"{"models":[{"id":"gpt-5.5","contextWindow":272000,"maxContextWindow":1000000}]}"#,
        )
        .unwrap();
        let s = service_in(dir.path(), Vec::new()).await.with_rosters(dir.path().to_path_buf(), io()).await;
        let w = s.cached_windows("openai-oauth", "gpt-5.5").unwrap();
        assert_eq!(serde_json::to_value(w).unwrap(), json!({"contextWindow": 272000.0, "maxContextWindow": 1000000.0}));
        assert!(s.cached_windows("openai-oauth", "other").is_none());
    }

    fn fast(provider: &str, id: &str, mode: Capability) -> ModelRecord {
        let mut r = ModelRecord::new(provider.into(), id);
        r.fast_mode = mode;
        r
    }

    #[test]
    fn documented_ids_match_the_node_patterns() {
        for id in ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-2025", "gpt-5.5-1234x", "gpt-6-sol-2026-01-02", "gpt-5.6-terra"] {
            assert!(documented_fast(id), "{id}");
        }
        for id in ["gpt-5.3", "gpt-5.5x", "gpt-5.4-mini-1", "gpt-6-sol-2026-01", "gpt-5.6", "xgpt-5.5"] {
            assert!(!documented_fast(id), "{id}");
        }
        assert!(documented_ultrafast("gpt-6.1-sol-2026-01-02"));
        assert!(!documented_ultrafast("gpt-6-luna"));
        assert!(known_anthropic_fast("claude-opus-4-8-20260101") && known_anthropic_fast("claude-opus-5@x"));
        assert!(!known_anthropic_fast("claude-opus-4-80") && !known_anthropic_fast("claude-opus-4-7"));
        assert_eq!(without_snapshot("gpt-5-2025-08-07"), "gpt-5");
        assert_eq!(without_snapshot("gpt-5-20250807"), "gpt-5-20250807");
    }

    #[tokio::test]
    async fn fast_capable_orders_the_declarations_as_node_does() {
        let s = golden_service(Vec::new()).await;
        let none = json!({});
        // The route row's own flag first.
        assert!(!s.fast_capable("anthropic", &json!({"id": "claude-opus-5", "supportsFastMode": false}), None, &none));
        assert!(s.fast_capable("anthropic-oauth", &json!({"id": "claude-nova-9", "supportsFastMode": true}), None, &none));
        // Then the catalog, then a published Priority rate, then the documented ids.
        assert!(s.fast_capable("anthropic", &json!({"id": "claude-opus-5"}), None, &none));
        assert!(!s.fast_capable("openai", &json!({"id": "gpt-5.2"}), None, &none));
        assert!(s.fast_capable("openai", &json!({"id": "gpt-5.4"}), None, &none));
        assert!(s.fast_capable("openai", &json!("gpt-5.4-mini"), None, &none));
        assert!(!s.fast_capable("openai", &json!({"id": "unknown"}), None, &none));
        assert!(!s.fast_capable("grok-oauth", &json!({"id": "x", "supportsFastMode": true}), None, &none));
        let tiers = json!({"id": "m", "serviceTiers": [{"id": "priority"}]});
        assert!(s.fast_capable("openai-oauth", &tiers, None, &none));
        assert!(!s.ultrafast_capable("openai-oauth", &tiers));
        assert!(s.ultrafast_capable("openai-oauth", &json!({"additionalSpeedTiers": ["ultrafast"]})));
        assert!(s.ultrafast_capable("openai", &json!({"id": "gpt-6-astra"})));
        assert!(!s.ultrafast_capable("anthropic", &json!({"id": "gpt-6-astra"})));
    }

    #[tokio::test]
    async fn cursor_fast_follows_variants_and_efforts() {
        let s = service(Vec::new()).await;
        let model = json!({"id": "c", "fastCapable": true, "fastEfforts": ["low", "high"]});
        assert!(s.fast_capable("cursor-oauth", &model, Some("high"), &json!({})));
        assert!(!s.fast_capable("cursor-oauth", &model, Some("medium"), &json!({})));
        assert!(s.fast_capable("cursor-api", &model, None, &json!({})));
        assert!(!s.fast_capable("cursor-oauth", &json!({"id": "c"}), None, &json!({})));
        let variants = json!({"id": "c", "fastCapable": true, "parameterVariants": [
            {"fast": "true", "effort": "high", "thinking": "on"},
            {"fast": "false", "effort": "low"}
        ]});
        assert!(s.fast_capable("cursor-oauth", &variants, Some("high"), &json!({"thinking": "on"})));
        assert!(!s.fast_capable("cursor-oauth", &variants, Some("high"), &json!({"thinking": "off"})));
        assert!(!s.fast_capable("cursor-oauth", &variants, Some("low"), &json!({})));
    }

    #[tokio::test]
    async fn meta_is_the_row_or_the_bare_placeholder() {
        let mut row = fast("openai", "gpt-5.5", Capability::Yes);
        row.context_window = Some(272_000);
        row.reasoning_efforts = vec!["low".into(), "high".into()];
        let s = golden_service(vec![row]).await;
        let meta = s.model_meta("openai", "gpt-5.5");
        // The provider's listed limits stand; the catalog layers fill the rest.
        assert_eq!(meta["contextWindow"], 272_000);
        assert_eq!(meta["supportsFastMode"], true);
        assert_eq!(meta["supportsVision"], true);
        assert_eq!(meta["inputCostPerM"], 1.25);
        assert_eq!(meta["reasoningOptions"], json!([{"type": "effort", "values": ["low", "high"]}]));
        assert_eq!(s.model_meta("openai", "nope"), json!({"id": "nope", "provider": "openai"}));
        assert!(s.catalog_knows("gpt-5.5", "openai"));
        assert!(!s.catalog_knows("gpt-5.5", "anthropic") && !s.catalog_knows("", "openai"));
        assert_eq!(s.cached_windows("openai-oauth", "gpt-5.5").unwrap().max_context_window, 1_000_000.0);
    }

    /// Every (provider, model) of the Node golden: `catalog_knows`
    /// (`set-route.mjs:57`'s `getModelMetadataSync` truthiness),
    /// `fastCapableFor` and `ultrafastCapableFor`.
    #[tokio::test]
    async fn knowledge_and_fast_tiers_equal_node() {
        let s = golden_service(Vec::new()).await;
        let golden = lookup::fixtures::json(lookup::fixtures::GOLDEN);
        let none = json!({});
        let mut failures = Vec::new();
        for row in golden["rows"].as_array().unwrap() {
            let provider = row["provider"].as_str().unwrap();
            let id = row["id"].as_str().unwrap();
            let got = (s.catalog_knows(id, provider), s.fast_capable(provider, &json!({"id": id}), None, &none), s.ultrafast_capable(provider, &json!({"id": id})));
            let want = (row["known"].as_bool().unwrap(), row["fast"].as_bool().unwrap(), row["ultrafast"].as_bool().unwrap());
            if got != want {
                failures.push(format!("{provider:?} {id:?}: rust {got:?} node {want:?}"));
            }
        }
        assert!(failures.is_empty(), "{} differ; first:\n{}", failures.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
        // The golden must reach both answers of every check.
        let rows = golden["rows"].as_array().unwrap();
        for key in ["known", "fast", "ultrafast"] {
            assert!(rows.iter().any(|r| r[key] == true) && rows.iter().any(|r| r[key] == false), "{key}");
        }
    }
}
