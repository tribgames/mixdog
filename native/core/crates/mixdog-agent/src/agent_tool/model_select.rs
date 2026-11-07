//! One-off model selection for a spawn the user explicitly pinned to a model (Node
//! `agent-tool/model-select.mjs`). The agent's preset route stays the default; this runs only
//! when `model` is passed. The query is matched against the quick/cached provider catalog
//! (literal id, then normalized id, then exact display name, then every query word); a
//! catalog miss retries once on a catalog refreshed for the requested provider. One match
//! runs; several or none fail with candidates instead of substituting another model.
//!
//! Concurrent misses share one refresh in Node; sharing is the catalog implementation's
//! concern here, since the catalog is the thing being refreshed.

use async_trait::async_trait;
use serde_json::Value;

use super::scope::clean;

const CANDIDATE_LIMIT: usize = 8;

#[derive(Clone, PartialEq, Debug)]
pub struct ModelRow {
    pub provider: String,
    pub id: String,
    pub display: String,
    /// A quick read answered from the loaded catalog marks every row complete.
    pub catalog_complete: bool,
}

#[derive(Clone, Default, PartialEq, Debug)]
pub struct ListOptions {
    pub quick: bool,
    pub force: bool,
    pub provider: Option<String>,
}

#[async_trait]
pub trait ModelCatalog: Send + Sync {
    /// `listProviderModels(options)`; `Err` is the throw of a provider load, which the caller's
    /// resolution does not catch.
    async fn list(&self, options: ListOptions) -> Result<Vec<ModelRow>, String>;
}

/// `String(value).toLowerCase().replace(/[^a-z0-9]+/g, '')`.
fn norm(value: &str) -> String {
    value.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

/// `String(value).toLowerCase().split(/\s+/).map(norm).filter(Boolean)`.
fn terms(value: &str) -> Vec<String> {
    value.to_lowercase().split(mixdog_js::is_js_space).map(norm).filter(|t| !t.is_empty()).collect()
}

fn label(row: &ModelRow) -> String {
    format!("{}/{}", row.provider, row.id)
}

fn provider_rows(rows: Vec<ModelRow>, provider: &str) -> Vec<ModelRow> {
    if provider.is_empty() {
        return rows;
    }
    let wanted = norm(provider);
    let exact: Vec<ModelRow> = rows.iter().filter(|r| norm(&r.provider) == wanted).cloned().collect();
    if !exact.is_empty() {
        return exact;
    }
    rows.into_iter().filter(|r| norm(&r.provider).contains(&wanted)).collect()
}

fn match_models(rows: &[ModelRow], query: &str) -> Vec<ModelRow> {
    let wanted = norm(query);
    let words = terms(query);
    // Nothing to match on ("???"): an empty `every` would accept every row.
    if words.is_empty() {
        return Vec::new();
    }
    type Tier<'a> = Box<dyn Fn(&ModelRow) -> bool + 'a>;
    let tiers: [Tier; 4] = [
        // A literal id wins over its normalized look-alikes (`foo-bar` vs `foo_bar`).
        Box::new(|r| r.id == query),
        Box::new(|r| norm(&r.id) == wanted),
        Box::new(|r| norm(&r.display) == wanted),
        Box::new(|r| {
            let hay = format!("{} {}", norm(&r.id), norm(&r.display));
            words.iter().all(|w| hay.contains(w.as_str()))
        }),
    ];
    for test in &tiers {
        let hits: Vec<ModelRow> = rows.iter().filter(|r| test(r)).cloned().collect();
        if !hits.is_empty() {
            return hits;
        }
    }
    Vec::new()
}

fn candidates(rows: &[ModelRow]) -> String {
    let shown = rows.iter().take(CANDIDATE_LIMIT).map(label).collect::<Vec<_>>().join(", ");
    if rows.len() > CANDIDATE_LIMIT { format!("{shown}, … ({} total)", rows.len()) } else { shown }
}

/// A quick read answered from the loaded catalog marks every row complete. Otherwise a hit
/// stands only when it is a literal id of the exact provider the caller named, which the full
/// catalog would pick the same way.
fn quick_answer_holds(rows: &[ModelRow], hits: &[ModelRow], model: &str, provider: &str) -> bool {
    if !rows.is_empty() && rows.iter().all(|r| r.catalog_complete) {
        return true;
    }
    let wanted = norm(provider);
    !hits.is_empty() && !wanted.is_empty() && hits.iter().all(|r| r.id == model && norm(&r.provider) == wanted)
}

fn provider_scope(provider: &str) -> Option<String> {
    (!provider.is_empty()).then(|| provider.to_owned())
}

/// Resolves `args.provider`/`args.model` to one exact catalog route. Without a catalog
/// (headless/daemon surfaces) exact provider + model pass through.
pub async fn resolve_requested_model(args: &Value, catalog: Option<&dyn ModelCatalog>) -> Result<Value, String> {
    let model = clean(args.get("model"));
    let provider = clean(args.get("provider"));
    if model.is_empty() {
        if !provider.is_empty() {
            return Err("agent spawn: provider requires model".into());
        }
        return Ok(args.clone());
    }
    let Some(catalog) = catalog else {
        if provider.is_empty() {
            return Err("agent spawn: model requires provider on this surface".into());
        }
        // Punctuation alone names no model; the catalog path rejects it the same way.
        if terms(&model).is_empty() {
            return Err(format!("agent spawn: model \"{model}\" for provider \"{provider}\" not found"));
        }
        return Ok(args.clone());
    };
    // The quick/cached catalog answers first. A loaded catalog is final, so its hit never
    // waits on a provider; an incomplete one (cold or partial) may lack the model that wins,
    // or one that makes the name ambiguous, so only a literal id inside an exact, explicitly
    // named provider is taken from it. Anything else waits for the full catalog.
    let quick_rows = catalog.list(ListOptions { quick: true, ..ListOptions::default() }).await?;
    let mut pool = provider_rows(quick_rows.clone(), &provider);
    let mut hits = match_models(&pool, &model);
    if !quick_answer_holds(&quick_rows, &hits, &model, &provider) {
        pool = provider_rows(catalog.list(ListOptions::default()).await?, &provider);
        hits = match_models(&pool, &model);
    }
    if hits.is_empty() {
        let refreshed = catalog.list(ListOptions { force: true, provider: provider_scope(&provider), quick: false }).await?;
        pool = provider_rows(refreshed, &provider);
        hits = match_models(&pool, &model);
    }
    if hits.len() == 1 {
        let mut out = args.clone();
        out["provider"] = Value::String(hits[0].provider.clone());
        out["model"] = Value::String(hits[0].id.clone());
        return Ok(out);
    }
    let scope = if provider.is_empty() { String::new() } else { format!(" for provider \"{provider}\"") };
    if hits.len() > 1 {
        return Err(format!("agent spawn: model \"{model}\"{scope} is ambiguous: {}; pass the exact one", candidates(&hits)));
    }
    if pool.is_empty() {
        return Err(format!("agent spawn: provider \"{provider}\" has no available models"));
    }
    Err(format!("agent spawn: model \"{model}\"{scope} not found; available: {}", candidates(&pool)))
}
