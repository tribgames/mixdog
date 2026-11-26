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
async fn prefer_agent_provider(catalog: &dyn ModelCatalog, own: &str, model: &str, hits: Vec<ModelRow>) -> Result<(Vec<ModelRow>, Option<String>), String> {
    let wanted = norm(own);
    let (mine, others): (Vec<ModelRow>, Vec<ModelRow>) = hits.iter().cloned().partition(|r| provider_exact_match(r, &wanted));
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

fn is_acp_row(row: &ModelRow) -> bool {
    row.row.get("runner").and_then(Value::as_str) == Some("acp") || row.provider.to_ascii_lowercase().starts_with("acp-")
}

/// An ACP row matches only its exact provider id or its exact preset id (`row["agent"]`), never by substring.
fn acp_row_matches(row: &ModelRow, wanted: &str) -> bool {
    !wanted.is_empty() && (norm(&row.provider) == wanted || row.row.get("agent").and_then(Value::as_str).is_some_and(|id| norm(id) == wanted))
}

fn provider_exact_match(row: &ModelRow, wanted: &str) -> bool {
    if is_acp_row(row) { acp_row_matches(row, wanted) } else { norm(&row.provider) == wanted }
}

/// ACP rows participate only when the request names that ACP preset/provider or the spawning
/// agent's own route is that ACP provider; non-ACP selection is unchanged.
fn eligible_rows(rows: Vec<ModelRow>, provider: &str, own_provider: Option<&str>) -> Vec<ModelRow> {
    if provider.is_empty() {
        let own = own_provider.map(norm).filter(|p| !p.is_empty());
        return rows.into_iter().filter(|r| !is_acp_row(r) || own.as_deref().is_some_and(|wanted| acp_row_matches(r, wanted))).collect();
    }
    let wanted = norm(provider);
    rows.into_iter().filter(|r| !is_acp_row(r) || acp_row_matches(r, &wanted)).collect()
}

fn provider_rows(rows: Vec<ModelRow>, provider: &str) -> Vec<ModelRow> {
    if provider.is_empty() {
        return rows;
    }
    let wanted = norm(provider);
    let exact: Vec<ModelRow> = rows.iter().filter(|r| provider_exact_match(r, &wanted)).cloned().collect();
    if !exact.is_empty() {
        return exact;
    }
    rows.into_iter().filter(|r| !is_acp_row(r) && norm(&r.provider).contains(&wanted)).collect()
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
        Box::new(|r| norm(&r.display) == wanted || r.row.get("modelName").and_then(Value::as_str).is_some_and(|n| norm(n) == wanted)),
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
    !hits.is_empty() && !wanted.is_empty() && hits.iter().all(|r| r.id == model && provider_exact_match(r, &wanted))
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
            match note {
                Some(n) => format!("{n}; {runs} instead"),
                None => runs,
            }
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
    let agent = clean(args.get("agent"));
    let own_provider = if provider.is_empty() && !agent.is_empty() { catalog.agent_provider(&agent).await.filter(|p| !p.is_empty()) } else { None };
    let quick_rows = eligible_rows(catalog.list(ListOptions { quick: true, ..ListOptions::default() }).await?, &provider, own_provider.as_deref());
    let mut pool = provider_rows(quick_rows.clone(), &provider);
    let mut hits = match_models(&pool, &model);
    if !quick_answer_holds(&quick_rows, &hits, &model, &provider) {
        let loaded = eligible_rows(catalog.list(ListOptions::default()).await?, &provider, own_provider.as_deref());
        pool = provider_rows(loaded, &provider);
        hits = match_models(&pool, &model);
    }
    if hits.is_empty() {
        let refreshed = eligible_rows(
            catalog.list(ListOptions { force: true, provider: provider_scope(&provider), quick: false }).await?,
            &provider,
            own_provider.as_deref(),
        );
        pool = provider_rows(refreshed, &provider);
        hits = match_models(&pool, &model);
    }
    let mut note = None;
    if provider.is_empty()
        && !hits.is_empty()
        && let Some(own) = own_provider.as_deref()
    {
        (hits, note) = prefer_agent_provider(catalog, own, &model, hits).await?;
    }
    if hits.len() == 1 {
        return Ok((with_model_settings(args, &hits[0])?, note));
    }
    let scope = if provider.is_empty() { String::new() } else { format!(" for provider \"{provider}\"") };
    if hits.len() > 1 {
        return Err(format!("agent spawn: model \"{model}\"{scope} is ambiguous: {}; pass the exact one", candidates(&hits)));
    }
    if pool.is_empty() {
        if !provider.is_empty()
            && let Some(state) = catalog.provider_state(&provider).await
        {
            return Err(format!("agent spawn: provider \"{provider}\" has no available models: {state}"));
        }
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

    struct RowsCatalog {
        rows: Vec<ModelRow>,
        own: Option<&'static str>,
        down: Vec<(&'static str, &'static str)>,
    }

    #[async_trait]
    impl ModelCatalog for RowsCatalog {
        async fn list(&self, _options: ListOptions) -> Result<Vec<ModelRow>, String> {
            Ok(self.rows.clone())
        }
        async fn agent_provider(&self, _agent: &str) -> Option<String> {
            self.own.map(str::to_owned)
        }
        async fn provider_state(&self, provider: &str) -> Option<String> {
            self.down.iter().find(|(p, _)| *p == provider).map(|(_, s)| (*s).into())
        }
    }

    #[tokio::test]
    async fn an_acp_provider_with_no_models_refuses_without_spilling_into_a_prefix_sibling() {
        let catalog = RowsCatalog {
            rows: vec![ModelRow {
                provider: "acp-antigravity-cli".into(),
                id: "claude-opus-5-5".into(),
                display: "Antigravity · Claude Opus 5.5".into(),
                catalog_complete: true,
                row: json!({ "runner": "acp", "agent": "antigravity-cli", "modelName": "Claude Opus 5.5" }),
            }],
            own: None,
            down: vec![
                ("acp-antigravity", "Antigravity is signed out. Sign in to it in Settings."),
                ("acp_antigravity", "Antigravity is signed out. Sign in to it in Settings."),
                ("antigravity", "Antigravity is signed out. Sign in to it in Settings."),
            ],
        };
        for provider in ["acp-antigravity", "acp_antigravity", "antigravity"] {
            let err = resolve_requested_model(&json!({ "provider": provider, "model": "claude-opus-5-5" }), Some(&catalog)).await.unwrap_err();
            assert!(err.contains(provider) && err.contains("has no available models") && err.contains("signed out"), "{provider}: {err}");
        }

        let sub_err = resolve_requested_model(&json!({ "provider": "anti", "model": "claude-opus-5-5" }), Some(&catalog)).await.unwrap_err();
        assert_eq!(sub_err, "agent spawn: provider \"anti\" has no available models");

        let empty_err = resolve_requested_model(&json!({ "provider": "acp-empty", "model": "gemini-4-neon" }), Some(&catalog)).await.unwrap_err();
        assert_eq!(empty_err, "agent spawn: provider \"acp-empty\" has no available models");
    }

    #[tokio::test]
    async fn model_only_spawns_exclude_acp_rows_unless_the_agents_own_route_is_that_acp_provider() {
        let rows = vec![
            ModelRow {
                provider: "anthropic-oauth".into(),
                id: "claude-opus-5-5".into(),
                display: "Claude Opus 5.5".into(),
                catalog_complete: true,
                row: json!({}),
            },
            ModelRow {
                provider: "acp-antigravity".into(),
                id: "gemini-4-neon".into(),
                display: "Antigravity · Gemini 4 Neon".into(),
                catalog_complete: true,
                row: json!({ "runner": "acp", "agent": "antigravity", "modelName": "Gemini 4 Neon" }),
            },
            ModelRow {
                provider: "acp-antigravity-cli".into(),
                id: "claude-opus-5-5".into(),
                display: "Antigravity · Claude Opus 5.5".into(),
                catalog_complete: true,
                row: json!({ "runner": "acp", "agent": "antigravity-cli", "modelName": "Claude Opus 5.5" }),
            },
        ];

        // No provider, no agent: ready ACP rows do not make non-ACP model-only spawns ambiguous or match ACP-only models.
        let plain = RowsCatalog { rows: rows.clone(), own: None, down: vec![] };
        let (routed, note) = resolve_requested_model(&json!({ "model": "claude-opus-5-5" }), Some(&plain)).await.unwrap();
        assert_eq!((routed["provider"].as_str(), routed["model"].as_str()), (Some("anthropic-oauth"), Some("claude-opus-5-5")));
        assert_eq!(note, "runs on anthropic-oauth/claude-opus-5-5");
        let missing = resolve_requested_model(&json!({ "model": "gemini-4-neon" }), Some(&plain)).await.unwrap_err();
        assert!(missing.contains("not found") && !missing.contains("acp-antigravity"), "{missing}");

        // Agent on a non-ACP route: ACP rows stay excluded.
        let non_acp_agent = RowsCatalog { rows: rows.clone(), own: Some("anthropic-oauth"), down: vec![] };
        let (routed, _) = resolve_requested_model(&json!({ "agent": "writer", "model": "claude-opus-5-5" }), Some(&non_acp_agent)).await.unwrap();
        assert_eq!(routed["provider"], "anthropic-oauth");

        // Agent on `acp-antigravity`: only `acp-antigravity` participates, not `acp-antigravity-cli`.
        let acp_agent = RowsCatalog { rows, own: Some("acp-antigravity"), down: vec![] };
        let (routed, note) = resolve_requested_model(&json!({ "agent": "writer", "model": "gemini-4-neon" }), Some(&acp_agent)).await.unwrap();
        assert_eq!((routed["provider"].as_str(), routed["model"].as_str()), (Some("acp-antigravity"), Some("gemini-4-neon")));
        assert_eq!(note, "runs on acp-antigravity/gemini-4-neon");
        let (non_acp, _) = resolve_requested_model(&json!({ "agent": "writer", "model": "claude-opus-5-5" }), Some(&acp_agent)).await.unwrap();
        assert_eq!(non_acp["provider"], "anthropic-oauth");
    }

    #[tokio::test]
    async fn an_acp_model_name_resolves_at_the_exact_display_tier() {
        let catalog = RowsCatalog {
            rows: vec![
                ModelRow {
                    provider: "acp-antigravity-cli".into(),
                    id: "claude-4-5-sonnet".into(),
                    display: "Antigravity · Claude Sonnet 4.5".into(),
                    catalog_complete: true,
                    row: json!({ "runner": "acp", "agent": "antigravity-cli", "modelName": "Claude Sonnet 4.5" }),
                },
                ModelRow {
                    provider: "acp-antigravity-cli".into(),
                    id: "claude-4-5-sonnet-thinking".into(),
                    display: "Antigravity · Claude Sonnet 4.5 Thinking".into(),
                    catalog_complete: true,
                    row: json!({ "runner": "acp", "agent": "antigravity-cli", "modelName": "Claude Sonnet 4.5 Thinking" }),
                },
            ],
            own: None,
            down: vec![],
        };
        let (routed, note) =
            resolve_requested_model(&json!({ "provider": "acp-antigravity-cli", "model": "Claude Sonnet 4.5" }), Some(&catalog)).await.unwrap();
        assert_eq!((routed["provider"].as_str(), routed["model"].as_str()), (Some("acp-antigravity-cli"), Some("claude-4-5-sonnet")));
        assert_eq!(note, "runs on acp-antigravity-cli/claude-4-5-sonnet");
    }
}
