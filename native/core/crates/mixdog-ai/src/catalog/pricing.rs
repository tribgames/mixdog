//! Usage pricing over the resident catalog: `priceUsage` (`cost.mjs`) and
//! `pricingCatalogRevisionSync` (`model-catalog.mjs`).
//!
//! A [`PricingCatalog`] exists only for a catalog whose LiteLLM and models.dev
//! tables are both resident, so a price or revision can never be read from a
//! cold one (which would price nothing and stamp an empty revision as checked).

use std::sync::Arc;

use mixdog_js::json_stringify as stringify;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use super::lookup::Obj;
use super::lookup::RATE_KEYS;
use super::service::CatalogService;
use crate::service::admin_route::jnum;
use crate::service::admin_route::truthy;

/// The catalog has not loaded its price tables.
#[derive(Debug, thiserror::Error)]
#[error("the pricing catalog is not loaded")]
pub struct ColdCatalog;

/// A catalog proven warm when it was built; the tables never unload.
#[derive(Clone)]
pub struct PricingCatalog {
    service: Arc<CatalogService>,
}

impl CatalogService {
    /// The pricing view, or [`ColdCatalog`] until both tables are resident
    /// (warm them from disk, or refresh, first).
    pub fn pricing(self: &Arc<Self>) -> Result<PricingCatalog, ColdCatalog> {
        self.warm_stamps().ok_or(ColdCatalog)?;
        Ok(PricingCatalog { service: self.clone() })
    }
}

impl CatalogService {
    /// The pricing view whether or not the tables are resident: what Node's `priceUsage` and
    /// `pricingCatalogRevisionSync` read after `warmCatalogFromDisk`, which finds nothing to load
    /// on a machine with no cache. Cold, a model no table names is unpriced and the revision is
    /// the empty-tables one (both recorded from Node). The usage-ledger refresh runs on this.
    pub fn pricing_unchecked(self: &Arc<Self>) -> PricingCatalog {
        PricingCatalog { service: self.clone() }
    }
}

/// priceUsage for a send whose catalog may still be cold: a model no table names is unpriced
/// (model-not-found), as in Node. Ledger rows are written whether or not the tables are loaded.
pub struct CatalogPricing(pub Arc<CatalogService>);

impl crate::registry::accounting::UsagePricing for CatalogPricing {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        PricingCatalog { service: self.0.clone() }.price_usage(args)
    }
}
/// One route of the price audit (`pricingAuditRows`): a model, or a wire id of one, and the rates the catalog lacks for it.
#[derive(Clone, Debug, PartialEq)]
pub struct AuditRow {
    pub provider: String,
    pub model: String,
    pub missing_rates: Vec<&'static str>,
}

impl AuditRow {
    pub fn priced(&self) -> bool {
        self.missing_rates.is_empty()
    }
}

impl CatalogService {
    /// `pricingAuditRows(models, provider, metadataOf)` with `getModelMetadataSync` as the metadata: every picker id and every
    /// wire id of each model needs an input and an output rate, and a cache-read rate when the model caches prompts.
    pub fn audit_rows(&self, models: &[Value], provider: &str) -> Vec<AuditRow> {
        let mut rows = Vec::new();
        for model in models {
            let mut ids: Vec<String> = Vec::new();
            let mut add = |id: &str| {
                if !id.is_empty() && !ids.iter().any(|seen| seen == id) {
                    ids.push(id.to_owned());
                }
            };
            add(model.get("id").and_then(Value::as_str).unwrap_or_default());
            match model.get("wire") {
                Some(Value::String(wire)) => add(wire),
                Some(Value::Object(wires)) => wires.values().filter_map(Value::as_str).for_each(&mut add),
                _ => {}
            }
            let owner = if provider.is_empty() { model.get("provider").and_then(Value::as_str).unwrap_or_default() } else { provider };
            for id in ids {
                let meta = self.sync_meta(&id, owner);
                let has = |key: &str| meta.as_ref().and_then(|m| m.get(key)).is_some_and(|v| !v.is_null());
                let caches = meta.as_ref().is_some_and(|m| truthy(m.get("supportsPromptCaching")));
                let required: &[&'static str] = if caches { &["inputCostPerM", "outputCostPerM", "cacheReadCostPerM"] } else { &["inputCostPerM", "outputCostPerM"] };
                let missing_rates = required.iter().copied().filter(|key| !has(key)).collect();
                rows.push(AuditRow { provider: owner.to_owned(), model: id, missing_rates });
            }
        }
        rows
    }

    /// `auditCachedModelPricing`: judges every cached roster route against the resident tables and reports the unpriced ones,
    /// once per table revision (`lastAuditedRevision`). Returns the report it logged.
    pub fn audit_cached_pricing(self: &Arc<Self>) -> Option<String> {
        let revision = self.pricing_unchecked().revision();
        let rows: Vec<AuditRow> = super::rosters::ROSTER_PROVIDERS
            .iter()
            .flat_map(|provider| self.audit_rows(&self.rosters.load().cached_models(provider), provider))
            .collect();
        let unpriced: Vec<&AuditRow> = rows.iter().filter(|row| !row.priced()).collect();
        let mut audited = self.audited.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let report = (audited.as_deref() != Some(revision.as_str()) && !unpriced.is_empty()).then(|| {
            let routes: Vec<String> = unpriced.iter().map(|row| format!("{}/{} ({})", row.provider, row.model, row.missing_rates.join(", "))).collect();
            format!("[model-pricing] {}/{} catalog routes have no complete price: {}", unpriced.len(), rows.len(), routes.join("; "))
        });
        *audited = Some(revision);
        if let Some(report) = &report {
            tracing::warn!("{report}");
        }
        report
    }
}
/// Media billed outside the text token slots (`args.media`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Media {
    /// A provider-billed figure: the price, with or without a catalog row.
    pub reported_cost_usd: Option<f64>,
    pub output_image_tokens: f64,
    pub output_video_tokens: f64,
    pub images: f64,
    pub seconds: f64,
    pub resolution: Option<String>,
}

/// The arguments of `priceUsage(args)`. A token count that is not a finite
/// non-negative number counts as zero, as in Node.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageArgs {
    pub provider: String,
    pub model: String,
    pub requested_model: Option<String>,
    pub pricing_model: Option<String>,
    pub input_tokens: f64,
    pub input_tokens_inclusive: Option<bool>,
    pub input_tokens_known: Option<bool>,
    pub uncached_input_tokens: Option<f64>,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_write_tokens: f64,
    pub cache_write_1h_tokens: f64,
    pub request_service_tier: Option<String>,
    pub service_tier: Option<String>,
    pub kind: Option<String>,
    pub ts: Option<f64>,
    pub historical: bool,
    pub historical_aggregate: bool,
    pub media: Option<Media>,
}

/// `{input, costUsd, rates}`: `None` is an unknown price, not a free request.
#[derive(Clone, Debug)]
pub struct PricedUsage {
    pub input: f64,
    pub cost_usd: Option<f64>,
    /// The price snapshot, in the field order the route signature depends on.
    pub rates: Obj,
}

impl PricedUsage {
    /// `JSON.stringify(rates)`.
    pub fn rates_json(&self) -> String {
        stringify(&Value::Object(self.rates.clone()))
    }
}

fn n(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 { value } else { 0.0 }
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

/// `isInclusiveProvider`: every provider but Anthropic's reports the prompt
/// total including the cached portion.
fn is_inclusive_provider(provider: &str) -> bool {
    let p = provider.to_lowercase();
    !p.is_empty() && p != "anthropic" && p != "anthropic-oauth"
}

fn num(map: &Obj, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}

/// `meta[key] || {}`: a service tier's published rate columns.
fn section<'a>(meta: &'a Obj, key: &str, empty: &'a Obj) -> &'a Obj {
    meta.get(key).filter(|v| truthy(Some(v))).and_then(Value::as_object).unwrap_or(empty)
}

/// `ratesForPrompt`: the base rates, replaced by each crossed tier's.
fn rates_for_prompt(meta: &Obj, prompt_tokens: f64) -> [Option<f64>; 4] {
    let mut out = RATE_KEYS.map(|key| num(meta, key));
    for tier in meta.get("pricingTiers").and_then(Value::as_array).into_iter().flatten() {
        let Some(tier) = tier.as_object() else { continue };
        if num(tier, "aboveInputTokens").is_some_and(|above| prompt_tokens <= above) {
            continue;
        }
        for (slot, key) in out.iter_mut().zip(RATE_KEYS) {
            if let Some(rate) = num(tier, key) {
                *slot = Some(rate);
            }
        }
    }
    out
}

struct Charges {
    usd: f64,
    charged: bool,
    missing: Vec<&'static str>,
    rates: Obj,
}

/// `mediaCharges`: a used unit without a catalog rate is reported missing, never free.
fn media_charges(meta: &Obj, media: &Media, image_out: f64, video_out: f64) -> Charges {
    let mut out = Charges { usd: 0.0, charged: false, missing: Vec::new(), rates: Obj::new() };
    let mut bill = |amount: f64, key: &'static str, rate: Option<f64>, scale: f64| {
        if amount <= 0.0 {
            return;
        }
        out.charged = true;
        match rate {
            None => out.missing.push(key),
            Some(rate) => {
                out.usd += (amount * rate) / scale;
                out.rates.insert(key.into(), jnum(rate));
            }
        }
    };
    bill(image_out, "outputImageCostPerM", num(meta, "outputImageCostPerM"), 1_000_000.0);
    bill(video_out, "outputVideoCostPerM", num(meta, "outputVideoCostPerM"), 1_000_000.0);
    bill(n(media.images), "outputCostPerImage", num(meta, "outputCostPerImage"), 1.0);
    let resolution = media.resolution.as_deref().unwrap_or("").to_lowercase();
    let per_second = meta
        .get("outputCostPerSecondByResolution")
        .and_then(|by| by.get(&resolution))
        .filter(|rate| !rate.is_null())
        .and_then(Value::as_f64)
        .or_else(|| num(meta, "outputCostPerSecond"));
    bill(n(media.seconds), "outputCostPerSecond", per_second, 1.0);
    out
}

/// Number(x.toFixed(6))
fn round6(value: f64) -> f64 {
    mixdog_js::math::to_fixed(value, 6).parse().unwrap_or(value)
}

/// UTC weekday 1..=5 at 01:00-04:00 or 06:00-10:00 (DeepSeek's published
/// peak window); an unrepresentable time is not peak, as an invalid Date.
fn is_peak(ts: f64) -> bool {
    use chrono::Datelike;
    use chrono::Timelike;
    let Some(date) = chrono::DateTime::from_timestamp_millis(ts as i64) else { return false };
    let hour = date.hour();
    (1..=5).contains(&date.weekday().num_days_from_sunday()) && ((1..4).contains(&hour) || (6..10).contains(&hour))
}

impl PricingCatalog {
    /// `pricingCatalogRevisionSync()`: changes whenever any price may.
    pub fn revision(&self) -> String {
        let (litellm_at, models_dev_at) = self.service.warm_stamps().unwrap_or_default();
        let aliases: Vec<Value> = self
            .service
            .rosters
            .load()
            .cached_models("antigravity-oauth")
            .iter()
            .map(|row| {
                let mut alias = Obj::new();
                for key in ["id", "wire", "pricingModel"] {
                    if let Some(value) = row.get(key) {
                        alias.insert(key.into(), value.clone());
                    }
                }
                Value::Object(alias)
            })
            .collect();
        let text = stringify(&json!([2, litellm_at, models_dev_at, aliases]));
        Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// `priceUsage(args)`.
    pub fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        let cached = n(args.cache_read_tokens);
        let written = n(args.cache_write_tokens);
        let written_1h = n(args.cache_write_1h_tokens).min(written);
        let inclusive = args.input_tokens_inclusive.unwrap_or_else(|| is_inclusive_provider(&args.provider));
        let input = if args.input_tokens_known == Some(false) {
            0.0
        } else if let Some(uncached) = args.uncached_input_tokens {
            n(uncached)
        } else if inclusive {
            (n(args.input_tokens) - cached - written).max(0.0)
        } else {
            n(args.input_tokens)
        };
        // `resolveModelPricingIdentity`: the transport's explicit SKU wins, then
        // Grok's requested SKU, then the model.
        let requested = non_empty(&args.requested_model);
        let selected = non_empty(&args.pricing_model)
            .or_else(|| requested.filter(|_| args.provider == "grok-oauth"))
            .unwrap_or(&args.model);
        let pricing_model = self.service.with_lookup(|lookup| lookup.pricing_model(&args.provider, selected));
        let meta = self.service.sync_meta(&pricing_model, &args.provider);

        let mut provenance = Obj::new();
        provenance.insert("requestedModel".into(), requested.map_or(Value::Null, Value::from));
        provenance.insert("pricingModel".into(), Value::from(pricing_model.clone()));
        let from_meta = |key: &str| meta.as_ref().and_then(|m| m.get(key)).filter(|v| truthy(Some(v))).cloned();
        provenance.insert("pricingProvider".into(), from_meta("pricingProvider").unwrap_or_else(|| Value::from(args.provider.clone())));
        provenance.insert("pricingSource".into(), from_meta("pricingSource").unwrap_or(Value::Null));
        if args.input_tokens_known == Some(false) {
            provenance.insert("inputTokensKnown".into(), Value::Bool(false));
        }
        if let Some(tier) = non_empty(&args.request_service_tier) {
            provenance.insert("requestServiceTier".into(), Value::from(tier));
        }
        if let Some(tier) = non_empty(&args.service_tier) {
            provenance.insert("serviceTier".into(), Value::from(tier));
        }
        if written_1h != 0.0 {
            provenance.insert("cacheWrite1hTokens".into(), jnum(written_1h));
        }
        let unpriced = |rates: Obj, reason: &str| {
            let mut rates = rates;
            rates.insert("unpricedReason".into(), Value::from(reason));
            PricedUsage { input, cost_usd: None, rates }
        };

        let media = args.media.as_ref();
        if let Some(reported) = media.and_then(|m| m.reported_cost_usd).filter(|c| c.is_finite() && *c >= 0.0) {
            provenance.insert("pricingSource".into(), Value::from("provider"));
            return PricedUsage { input, cost_usd: Some(round6(reported)), rates: provenance };
        }
        let Some(meta) = meta.filter(|_| args.input_tokens_known != Some(false)) else {
            let reason = if args.input_tokens_known == Some(false) { "unmeasured-input" } else { "model-not-found" };
            return unpriced(provenance, reason);
        };

        let prompt_tokens = input + cached + written;
        // The tier the request carried decides its rate; only the OpenAI API
        // bills a ramp-downgraded Priority request at Standard rates.
        let sent_tier = args.request_service_tier.as_deref().unwrap_or("");
        let premium = matches!(sent_tier, "priority" | "ultrafast" | "fast")
            && !(args.kind.as_deref() == Some("api") && args.service_tier.as_deref() == Some("default"));
        // Anthropic fast mode is a flat 2x on fast-capable Opus; every other
        // premium request needs the model's published Fast/Priority rates.
        let anthropic_fast = premium && sent_tier == "fast" && self.service.supports_anthropic_fast_mode(&pricing_model);
        let empty = Obj::new();
        let rate_meta: &Obj = if args.service_tier.as_deref() == Some("flex") {
            section(&meta, "flexPricing", &empty)
        } else if premium && !anthropic_fast {
            section(&meta, if sent_tier == "ultrafast" { "ultrafastPricing" } else { "fastPricing" }, &empty)
        } else {
            &meta
        };
        let has_tiers_over = rate_meta
            .get("pricingTiers")
            .and_then(Value::as_array)
            .is_some_and(|tiers| tiers.iter().any(|t| t.as_object().and_then(|t| num(t, "aboveInputTokens")).is_some_and(|above| prompt_tokens > above)));
        if args.historical_aggregate && has_tiers_over {
            // A daily sum cannot establish which requests crossed a context boundary.
            return unpriced(provenance, "request-boundaries-unavailable");
        }
        let mut multiplier = 1.0;
        // DeepSeek's schedule is UTC. Without an exact time (legacy sessions) the list rate stays.
        if let Some(off_peak) = num(&meta, "offPeakMultiplier").filter(|m| *m != 0.0)
            && let Some(ts) = args.ts.filter(|t| t.is_finite())
            && !args.historical
            && !is_peak(ts)
        {
            multiplier *= off_peak;
        }
        if anthropic_fast {
            multiplier *= 2.0;
        }
        let image_out = media.map_or(0.0, |m| n(m.output_image_tokens).min(n(args.output_tokens)));
        let video_out = media.map_or(0.0, |m| n(m.output_video_tokens).min(n(args.output_tokens) - image_out));
        let tokens = [input, n(args.output_tokens) - image_out - video_out, cached, written - written_1h];
        let tier_rates = rates_for_prompt(rate_meta, prompt_tokens);
        let mut rates = provenance;
        let mut priced: [Option<f64>; 4] = [None; 4];
        for (i, key) in RATE_KEYS.iter().enumerate() {
            priced[i] = tier_rates[i].map(|rate| rate * multiplier);
            rates.insert((*key).into(), priced[i].map_or(Value::Null, jnum));
        }
        let cache_write_1h = (written_1h != 0.0).then(|| priced[0].map(|input_rate| input_rate * 2.0));
        if let Some(rate) = cache_write_1h {
            rates.insert("cacheWrite1hCostPerM".into(), rate.map_or(Value::Null, jnum));
        }
        let mut missing: Vec<&str> = RATE_KEYS.iter().zip(tokens).zip(priced).filter(|((_, amount), rate)| *amount > 0.0 && rate.is_none()).map(|((key, _), _)| *key).collect();
        if cache_write_1h == Some(None) {
            missing.push("cacheWrite1hCostPerM");
        }
        let charge = match media {
            Some(media) => media_charges(&meta, media, image_out, video_out),
            None => Charges { usd: 0.0, charged: false, missing: Vec::new(), rates: Obj::new() },
        };
        missing.extend(&charge.missing);
        if media.is_some() && !charge.charged && tokens.iter().all(|amount| *amount == 0.0) && written_1h == 0.0 {
            return unpriced(rates, "usage-not-reported");
        }
        if !missing.is_empty() {
            rates.insert("unpricedReason".into(), Value::from("missing-rate"));
            rates.insert("missingRates".into(), Value::from(missing));
            return PricedUsage { input, cost_usd: None, rates };
        }
        let sum = tokens.iter().zip(priced).fold(0.0, |sum, (amount, rate)| sum + amount * rate.unwrap_or(0.0));
        let one_hour = written_1h * cache_write_1h.flatten().unwrap_or(0.0);
        let cost = (sum + one_hour) / 1_000_000.0 + charge.usd;
        rates.extend(charge.rates);
        PricedUsage { input, cost_usd: Some(round6(cost)), rates }
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "fixture files")]
mod tests {
    use super::*;
    use crate::catalog::CatalogSnapshot;
    use crate::catalog::ModelsDevSource;
    use crate::catalog::facts::tests::Offline;
    use crate::catalog::facts::tests::io;
    use crate::catalog::lookup::fixtures;
    use crate::catalog::modelsdev_source::LITELLM_CACHE_FILE;
    use crate::catalog::modelsdev_source::MODELS_DEV_CACHE_FILE;

    /// A catalog warmed from cache files stamped `fetchedAt: 1`, as the Node
    /// recorder warms it, with the recorded roster files.
    async fn warm(dir: &std::path::Path) -> Arc<CatalogService> {
        let mut litellm = fixtures::json(fixtures::LITELLM);
        litellm.as_object_mut().unwrap().extend(fixtures::json(fixtures::PRICING_EXTRA).as_object().unwrap().clone());
        std::fs::write(dir.join(LITELLM_CACHE_FILE), format!("{{\"fetchedAt\":1,\"data\":{litellm}}}\n")).unwrap();
        std::fs::write(dir.join(MODELS_DEV_CACHE_FILE), format!("{{\"fetchedAt\":1,\"data\":{}}}\n", fixtures::MODELS_DEV)).unwrap();
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), io());
        let litellm = ModelsDevSource::litellm(Arc::new(Offline), dir.to_path_buf(), io());
        let service = CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await.with_litellm(litellm).await;
        service.rosters.store(Arc::new(fixtures::rosters()));
        Arc::new(service)
    }

    #[tokio::test]
    async fn a_cold_catalog_cannot_be_priced() {
        let dir = tempfile::tempdir().unwrap();
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io());
        let cold = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
        assert!(cold.pricing().is_err());
        // One resident table is not enough.
        let litellm = ModelsDevSource::litellm(Arc::new(Offline), dir.path().to_path_buf(), io());
        litellm.set_layer(crate::catalog::ModelsDev::from_litellm(fixtures::json(fixtures::LITELLM)));
        let half = Arc::new(
            CatalogService::cold_start(
                CatalogSnapshot::default(),
                Vec::new(),
                ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io()),
            )
            .await
            .with_litellm(litellm)
            .await,
        );
        assert!(half.pricing().is_err());
    }

    /// Every recorded `priceUsage` case and the revision equal Node's: cost,
    /// counted input, and the rate snapshot byte for byte (its field order is
    /// part of the route signature).
    #[tokio::test]
    async fn priced_usage_and_revision_equal_node() {
        let dir = tempfile::tempdir().unwrap();
        let pricing = warm(dir.path()).await.pricing().unwrap();
        let golden = fixtures::json(fixtures::PRICING_GOLDEN);
        assert_eq!(pricing.revision(), golden["revision"].as_str().unwrap());
        let mut failures = Vec::new();
        let (mut priced, mut unpriced) = (0, 0);
        for case in golden["cases"].as_array().unwrap() {
            let (scenario, provider, model) = (case[0].as_str().unwrap(), case[1].as_str().unwrap(), case[2].as_str().unwrap());
            let mut args = golden["args"][scenario].clone();
            args["provider"] = json!(provider);
            args["model"] = json!(model);
            let got = pricing.price_usage(&serde_json::from_value(args).unwrap());
            let (want_input, want_cost, want_rates) = (case[3].as_f64().unwrap(), case[4].as_f64(), golden["rates"][case[5].as_u64().unwrap() as usize].as_str().unwrap());
            if got.input != want_input || got.cost_usd != want_cost || got.rates_json() != want_rates {
                failures.push(format!("{scenario} {provider}/{model}: rust {:?} {:?} {}\n    node {want_input} {want_cost:?} {want_rates}", got.input, got.cost_usd, got.rates_json()));
            }
            if want_cost.is_some() { priced += 1 } else { unpriced += 1 }
        }
        assert!(failures.is_empty(), "{} differ; first:\n{}", failures.len(), failures.iter().take(5).cloned().collect::<Vec<_>>().join("\n"));
        assert!(priced > 1000 && unpriced > 1000, "the golden reaches both outcomes ({priced}/{unpriced})");
    }

    #[tokio::test]
    async fn the_revision_follows_the_table_stamps() {
        let dir = tempfile::tempdir().unwrap();
        let service = warm(dir.path()).await;
        let before = service.pricing().unwrap().revision();
        service.rosters.store(Arc::new(crate::catalog::Rosters::default()));
        // The antigravity aliases are part of the revision.
        assert_ne!(service.pricing().unwrap().revision(), before);
    }
}
