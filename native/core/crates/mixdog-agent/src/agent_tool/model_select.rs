//! One-off model selection for a spawn the user explicitly pinned to a model. The agent's preset route stays the default; this runs only
//! when `model` is passed. The query is matched against the quick/cached provider catalog
//! (literal id, then normalized id, then exact display name, then every query word); a
//! catalog miss retries once on a catalog refreshed for the requested provider. One match
//! runs; several or none fail with candidates instead of substituting another model.

use async_trait::async_trait;
use mixdog_ai::effort::coerce_effort_for;
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
    /// The whole catalog row, as the model picker hydrates it: the effort ladder, the catalog's
    /// default effort, the saved effort and the fast capability and preference of the model.
    pub row: Value,
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

    /// The provider of the agent's saved route, when it has one.
    async fn agent_provider(&self, _agent: &str) -> Option<String> {
        None
    }

    /// Why the provider cannot run a task now (signed out, no key, ACP agent off); `None` when it can.
    async fn provider_state(&self, _provider: &str) -> Option<String> {
        None
    }
}

/// The agent's own provider decides among several that offer the model: it wins when it can run;
/// when it cannot, the others stand in and the note says why.
async fn prefer_agent_provider(catalog: &dyn ModelCatalog, agent: &str, model: &str, hits: Vec<ModelRow>) -> Result<(Vec<ModelRow>, Option<String>), String> {
    let Some(own) = catalog.agent_provider(agent).await.filter(|p| !p.is_empty()) else { return Ok((hits, None)) };
    let wanted = norm(&own);
    let (mine, others): (Vec<ModelRow>, Vec<ModelRow>) = hits.iter().cloned().partition(|r| norm(&r.provider) == wanted);
    if mine.is_empty() {
        return Ok((hits, None));
    }
    let Some(state) = catalog.provider_state(&mine[0].provider).await else { return Ok((mine, None)) };
    let mut runnable = Vec::new();
    for row in others {
        if catalog.provider_state(&row.provider).await.is_none() {
            runnable.push(row);
        }
    }
    if runnable.is_empty() {
        return Err(format!("agent spawn: model \"{model}\" is offered by provider \"{}\", which cannot run: {state}", mine[0].provider));
    }
    let note = format!("provider \"{}\" offers \"{model}\" but cannot run: {state}", mine[0].provider);
    Ok((runnable, Some(note)))
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

/// The efforts the model picker prefers, first offered wins (`EFFORT_PREFERENCE`).
const EFFORT_PREFERENCE: [&str; 7] = ["high", "medium", "low", "none", "xhigh", "max", "ultra"];

/// `catalogDefaultEffort` (the picker's `route-selection/effort.mjs`): the saved effort, else the
/// catalog's default, else the preference order, each only while the model offers it.
fn catalog_default_effort(row: &Value, values: &[&str]) -> Option<String> {
    let offered = |key: &str| row.get(key).and_then(Value::as_str).filter(|e| !e.is_empty() && values.contains(e));
    if let Some(effort) = offered("savedEffort").or_else(|| offered("defaultEffort")) {
        return Some(effort.to_owned());
    }
    EFFORT_PREFERENCE.iter().find(|e| values.contains(e)).or_else(|| values.first()).map(|e| (*e).to_owned())
}

/// The route a pinned model runs on takes what the model picker would select for it:
/// `modelDefaults` (its effort and fast), which the spawn's preset uses where the agent's own route
/// is not on this model. An effort the caller asked for is held to what the model offers (one it
/// does not offer is dropped: the model's own default applies); `fast: true` on a model that has no
/// fast mode is refused, so the caller is told instead of running without it. `modelDefaults.efforts`
/// is what the model offers, which the preset holds every effort of the final route to.
/// A row that carries no picker facts leaves the route as asked.
fn with_model_settings(args: &Value, hit: &ModelRow) -> Result<Value, String> {
    let mut out = args.clone();
    out["provider"] = Value::String(hit.provider.clone());
    out["model"] = Value::String(hit.id.clone());
    let Some(options) = hit.row.get("effortOptions").and_then(Value::as_array) else { return Ok(out) };
    let values: Vec<&str> = options.iter().filter_map(|o| o.get("value").and_then(Value::as_str)).filter(|v| !v.is_empty()).collect();
    let fast_capable = hit.row.get("fastCapable") == Some(&Value::Bool(true));
    if args.get("fast") == Some(&Value::Bool(true)) && !fast_capable {
        return Err(format!("agent spawn: model \"{}\" does not support fast; leave fast out or pick a model that offers it", label(hit)));
    }
    out["modelDefaults"] = serde_json::json!({
        "effort": catalog_default_effort(&hit.row, &values),
        "fast": fast_capable && hit.row.get("fastPreferred") == Some(&Value::Bool(true)),
        "efforts": values,
    });
    let asked = clean(args.get("effort")).to_lowercase();
    if !asked.is_empty() {
        match coerce_effort_for(&hit.provider, &hit.row, &asked, None).filter(|e| values.contains(&e.as_str())) {
            Some(effort) => out["effort"] = Value::String(effort),
            None => {
                out.as_object_mut().expect("args are an object").shift_remove("effort");
            }
        }
    }
    if let Some(fast) = args.get("fast") {
        out["fast"] = Value::Bool(fast == &Value::Bool(true));
    }
    Ok(out)
}

/// Resolves `args.provider`/`args.model` to one exact catalog route. Without a catalog
/// (headless/daemon surfaces) exact provider + model pass through.
/// The second value is the spawn result's note naming the provider and model the task runs on
/// (and why the agent's own provider was passed over); empty when no model was pinned.
pub async fn resolve_requested_model(args: &Value, catalog: Option<&dyn ModelCatalog>) -> Result<(Value, String), String> {
    let (routed, note) = resolve_route(args, catalog).await?;
    let note = match (clean(routed.get("provider")), clean(routed.get("model"))) {
        (p, m) if !m.is_empty() && !p.is_empty() => {
            let runs = format!("runs on {p}/{m}");
            note.map_or(runs.clone(), |n| format!("{n}; {runs} instead"))
        }
        _ => String::new(),
    };
    Ok((routed, note))
}

async fn resolve_route(args: &Value, catalog: Option<&dyn ModelCatalog>) -> Result<(Value, Option<String>), String> {
    let model = clean(args.get("model"));
    let provider = clean(args.get("provider"));
    if model.is_empty() {
        if !provider.is_empty() {
            return Err("agent spawn: provider requires model".into());
        }
        return Ok((args.clone(), None));
    }
    let Some(catalog) = catalog else {
        if provider.is_empty() {
            return Err("agent spawn: model requires provider on this surface".into());
        }
        // Punctuation alone names no model; the catalog path rejects it the same way.
        if terms(&model).is_empty() {
            return Err(format!("agent spawn: model \"{model}\" for provider \"{provider}\" not found"));
        }
        return Ok((args.clone(), None));
    };
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
    let mut note = None;
    let agent = clean(args.get("agent"));
    if provider.is_empty() && !agent.is_empty() && !hits.is_empty() {
        (hits, note) = prefer_agent_provider(catalog, &agent, &model, hits).await?;
    }
    if hits.len() == 1 {
        return Ok((with_model_settings(args, &hits[0])?, note));
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Fake {
        own: &'static str,
        down: Vec<(&'static str, &'static str)>,
        providers: Vec<&'static str>,
    }

    #[async_trait]
    impl ModelCatalog for Fake {
        async fn list(&self, _options: ListOptions) -> Result<Vec<ModelRow>, String> {
            Ok(self
                .providers
                .iter()
                .map(|p| ModelRow { provider: (*p).into(), id: "gemini-4-neon".into(), display: "Neon".into(), catalog_complete: true, row: json!({}) })
                .collect())
        }
        async fn agent_provider(&self, _agent: &str) -> Option<String> {
            Some(self.own.into())
        }
        async fn provider_state(&self, provider: &str) -> Option<String> {
            self.down.iter().find(|(p, _)| *p == provider).map(|(_, s)| (*s).into())
        }
    }

    fn args() -> Value {
        json!({ "agent": "writer", "model": "gemini-4-neon" })
    }

    #[tokio::test]
    async fn the_agents_own_runnable_provider_wins_among_several() {
        let fake = Fake { own: "cursor-oauth", down: vec![], providers: vec!["gemini", "cursor-oauth"] };
        let (routed, _) = resolve_requested_model(&args(), Some(&fake)).await.unwrap();
        assert_eq!(routed["provider"], "cursor-oauth");
    }

    #[tokio::test]
    async fn an_own_provider_that_cannot_run_is_named_and_replaced_or_refused() {
        let fake = Fake { own: "cursor-oauth", down: vec![("cursor-oauth", "signed out")], providers: vec!["gemini", "cursor-oauth"] };
        let (routed, note) = resolve_requested_model(&args(), Some(&fake)).await.unwrap();
        assert_eq!(routed["provider"], "gemini");
        assert!(note.contains("cursor-oauth") && note.contains("signed out") && note.contains("gemini/gemini-4-neon"), "{note}");
        let only = Fake { own: "cursor-oauth", down: vec![("cursor-oauth", "signed out")], providers: vec!["cursor-oauth"] };
        let err = resolve_requested_model(&args(), Some(&only)).await.unwrap_err();
        assert!(err.contains("cursor-oauth") && err.contains("signed out"), "{err}");
    }

    #[tokio::test]
    async fn the_result_note_names_the_provider_and_model_it_runs_on() {
        let fake = Fake { own: "", down: vec![], providers: vec!["gemini"] };
        let (_, note) = resolve_requested_model(&args(), Some(&fake)).await.unwrap();
        assert_eq!(note, "runs on gemini/gemini-4-neon");
    }
}
