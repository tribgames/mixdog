//! The list of models that can search the web: which tier answers a read (a forced scan of the enabled providers,
//! the adopted cache, the provider-models cache, the quick rows), what is adopted, and when a moved catalog drops
//! the adopted rows. The world is a small scripted one: providers, their listings and the catalog rows.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_ai::service::web_search_models::CatalogFacts;
use mixdog_ai::service::web_search_models::QuickFacts;
use mixdog_ai::service::web_search_models::WebSearchCatalog;
use mixdog_ai::service::web_search_models::hydrated_model;
use mixdog_ai::service::web_search_models::main_model_meta;
use mixdog_ai::service::web_search_models::quick_web_search_models;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

#[derive(Default)]
struct World {
    route: Value,
    providers: Vec<(String, Value)>,
    /// A provider's `listModels`; `Err` is a throw. A provider absent here cannot list.
    listings: HashMap<String, Result<Value, ()>>,
    /// A provider's live roster, what the quick rows read first.
    rosters: HashMap<String, Vec<Value>>,
    main_capable: bool,
    client: bool,
    ready_error: Option<String>,
    models_cache: Option<Vec<Value>>,
    collected: Vec<Value>,
    probe: Arc<Probe>,
}

/// What the catalog did to the world, and the one thing a test moves: the catalog revision.
#[derive(Default)]
struct Probe {
    revision: Mutex<f64>,
    listed: Mutex<Vec<String>>,
    remembered: Mutex<Vec<(String, String)>>,
    collected_with: Mutex<Vec<bool>>,
}

fn catalog_of(world: World) -> (WebSearchCatalog<World>, Arc<Probe>) {
    let probe = world.probe.clone();
    (WebSearchCatalog::new(world), probe)
}

fn enabled(name: &str) -> (String, Value) {
    (name.to_owned(), json!({"enabled": true}))
}

fn searcher(id: &str) -> Value {
    json!({"id": id, "supportsWebSearch": true})
}

fn plain(id: &str) -> Value {
    json!({"id": id, "supportsWebSearch": false})
}

fn sort_key(row: &Value) -> String {
    format!("{}\n{}", row["provider"].as_str().unwrap_or(""), row["id"].as_str().unwrap_or(""))
}

impl QuickFacts for World {
    fn route(&self) -> Value {
        self.route.clone()
    }
    fn display_providers(&self) -> Vec<(String, Value)> {
        self.providers.clone()
    }
    fn display_web_search_route(&self) -> Value {
        Value::Null
    }
    fn web_search_route_state(&self) -> Value {
        Value::Null
    }
    fn cached_models(&self, provider: &str) -> Vec<Value> {
        self.rosters.get(provider).cloned().unwrap_or_default()
    }
    fn models_dev(&self, _provider: &str) -> Option<Map<String, Value>> {
        None
    }
    fn hydrated(&self, provider: &str, model: &Value) -> Value {
        hydrated_model(provider, model, &json!({}))
    }
    fn cache_row(&self, provider: &str, model: &Value) -> Value {
        let mut row = model.as_object().cloned().unwrap_or_default();
        row.insert("provider".into(), provider.into());
        Value::Object(row)
    }
    fn capable_for(&self, _provider: &str, _model: &Value) -> bool {
        self.main_capable
    }
    fn main_model_meta(&self) -> Option<Value> {
        main_model_meta(&self.route, None)
    }
    fn sort(&self, mut rows: Vec<Value>) -> Vec<Value> {
        rows.sort_by_key(sort_key);
        rows
    }
}

#[async_trait]
impl CatalogFacts for World {
    fn quick(&self) -> &dyn QuickFacts {
        self
    }
    fn client_mode(&self) -> bool {
        self.client
    }
    fn revision(&self) -> f64 {
        *self.probe.revision.lock().unwrap()
    }
    fn models_cache(&self) -> Option<Vec<Value>> {
        self.models_cache.clone()
    }
    fn from_cache_rows(&self, rows: &[Value]) -> Vec<Value> {
        rows.to_vec()
    }
    async fn collect_provider_models(&self, force: bool) -> Result<Vec<Value>, String> {
        self.probe.collected_with.lock().unwrap().push(force);
        Ok(self.collected.clone())
    }
    async fn prepare(&self) -> Result<(), String> {
        Ok(())
    }
    fn providers_config(&self) -> Vec<(String, Value)> {
        self.providers.clone()
    }
    async fn ensure_providers_ready(&self) -> Result<(), String> {
        self.ready_error.clone().map_or(Ok(()), Err)
    }
    fn can_list(&self, name: &str) -> bool {
        self.listings.contains_key(name)
    }
    async fn refresh_models(&self, _name: &str) -> Option<Result<Value, ()>> {
        None
    }
    async fn list_models(&self, name: &str) -> Result<Value, ()> {
        self.probe.listed.lock().unwrap().push(name.to_owned());
        self.listings[name].clone()
    }
    fn remember(&self, provider: &str, id: &str, _row: &Value) {
        self.probe.remembered.lock().unwrap().push((provider.to_owned(), id.to_owned()));
    }
}

fn main_world() -> World {
    World {
        route: json!({"provider": "openai-oauth", "model": "gpt-5.5"}),
        main_capable: true,
        providers: vec![enabled("openai-oauth"), enabled("gemini")],
        listings: HashMap::from([
            ("openai-oauth".to_owned(), Ok(json!([searcher("gpt-5.5"), plain("gpt-4"), searcher("gpt-5.4")]))),
            ("gemini".to_owned(), Ok(json!([searcher("gemini-2.5-pro")]))),
        ]),
        ..World::default()
    }
}

fn ids(rows: &[Value]) -> Vec<String> {
    rows.iter().map(|r| format!("{}/{}", r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect()
}

#[tokio::test]
async fn a_forced_scan_lists_the_enabled_search_providers_and_keeps_the_rows_that_can_search() {
    let mut world = main_world();
    world.providers.push(("xai".to_owned(), json!({"enabled": false})));
    world.providers.push(enabled("deepseek"));
    world.listings.insert("xai".to_owned(), Ok(json!([searcher("grok-4")])));
    world.listings.insert("deepseek".to_owned(), Ok(json!([searcher("deepseek-chat")])));
    let (catalog, probe) = catalog_of(world);
    let rows = catalog.collect(true).await.unwrap();
    assert_eq!(ids(&rows), ["default/default", "openai-oauth/gpt-5.5", "openai-oauth/gpt-5.4", "gemini/gemini-2.5-pro"]);
    assert_eq!(rows[0]["display"], "Default");
    assert_eq!(rows[0]["description"], "Use current main model: openai-oauth/gpt-5.5");
    assert!(rows.iter().all(|r| r["webSearchCapable"] == true && r["webSearchToolType"] == "web_search"));
    assert_eq!(catalog.cached().map(|rows| rows.len()), Some(4), "the scan is adopted");
    let mut asked = probe.listed.lock().unwrap().clone();
    asked.sort();
    assert_eq!(asked, ["gemini", "openai-oauth"], "a disabled provider and one without hosted search are not listed");
    let mut kept = probe.remembered.lock().unwrap().clone();
    kept.sort();
    assert_eq!(
        kept,
        [
            ("gemini".to_owned(), "gemini-2.5-pro".to_owned()),
            ("openai-oauth".to_owned(), "gpt-5.4".to_owned()),
            ("openai-oauth".to_owned(), "gpt-5.5".to_owned())
        ],
        "every kept row is remembered for the model metadata"
    );
}

#[tokio::test]
async fn a_provider_whose_listing_fails_contributes_nothing_and_the_others_still_answer() {
    let mut world = main_world();
    world.listings.insert("gemini".to_owned(), Err(()));
    let (catalog, _) = catalog_of(world);
    let rows = catalog.collect(true).await.unwrap();
    assert_eq!(ids(&rows), ["default/default", "openai-oauth/gpt-5.5", "openai-oauth/gpt-5.4"]);
}

#[tokio::test]
async fn a_listing_that_is_not_a_list_and_rows_that_are_not_chat_models_are_ignored() {
    let mut world = main_world();
    world.listings.insert("gemini".to_owned(), Ok(json!({"models": []})));
    world.listings.insert(
        "openai-oauth".to_owned(),
        Ok(json!([searcher("gpt-5.5"), searcher("gpt-image-1"), {"id": "gpt-audio", "supportsWebSearch": true, "mode": "audio"}, {"supportsWebSearch": true}])),
    );
    let (catalog, _) = catalog_of(world);
    assert_eq!(ids(&catalog.collect(true).await.unwrap()), ["default/default", "openai-oauth/gpt-5.5"]);
}

#[tokio::test]
async fn the_default_row_is_left_out_when_the_main_model_cannot_search() {
    let mut world = main_world();
    world.main_capable = false;
    let (catalog, _) = catalog_of(world);
    let rows = catalog.collect(true).await.unwrap();
    assert_eq!(ids(&rows), ["openai-oauth/gpt-5.5", "openai-oauth/gpt-5.4", "gemini/gemini-2.5-pro"]);
}

#[tokio::test]
async fn no_enabled_search_provider_is_an_empty_list() {
    let mut world = main_world();
    world.providers = vec![("openai-oauth".to_owned(), json!({"enabled": false})), enabled("deepseek")];
    let (catalog, _) = catalog_of(world);
    assert!(catalog.collect(true).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_provider_that_is_not_ready_rejects_the_fresh_scan() {
    let mut world = main_world();
    world.ready_error = Some("providers are not ready".to_owned());
    let (catalog, _) = catalog_of(world);
    assert_eq!(catalog.collect(true).await, Err("providers are not ready".to_owned()));
}

#[tokio::test]
async fn an_unforced_read_answers_from_the_adopted_rows_without_listing_again() {
    let (catalog, probe) = catalog_of(main_world());
    let scanned = catalog.collect(true).await.unwrap();
    probe.listed.lock().unwrap().clear();
    let again = catalog.collect(false).await.unwrap();
    assert_eq!(ids(&again), ids(&scanned));
    assert!(probe.listed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_moved_catalog_revision_drops_the_adopted_rows_and_the_next_read_rebuilds_without_a_scan() {
    let mut world = main_world();
    world.models_cache = Some(vec![json!({"id": "gpt-5.5", "provider": "openai-oauth", "supportsWebSearch": true})]);
    let (catalog, probe) = catalog_of(world);
    catalog.collect(true).await.unwrap();
    assert_eq!(catalog.cached().map(|rows| rows.len()), Some(4));
    probe.listed.lock().unwrap().clear();
    *probe.revision.lock().unwrap() = 1.0;
    let rows = catalog.collect(false).await.unwrap();
    assert_eq!(ids(&rows), ["default/default", "openai-oauth/gpt-5.5"], "rebuilt from the provider-models cache");
    assert!(probe.listed.lock().unwrap().is_empty());
    assert_eq!(catalog.cached().map(|rows| rows.len()), Some(2), "the rebuilt rows are adopted");
}

#[tokio::test]
async fn invalidating_drops_the_adopted_rows() {
    let (catalog, _) = catalog_of(main_world());
    catalog.collect(true).await.unwrap();
    catalog.invalidate();
    assert!(catalog.cached().is_none());
}

#[tokio::test]
async fn the_provider_models_cache_answers_before_the_quick_rows_and_keeps_only_searchers_sorted() {
    let mut world = main_world();
    world.models_cache = Some(vec![
        json!({"id": "z-model", "provider": "gemini", "supportsWebSearch": true}),
        json!({"id": "chat-only", "provider": "gemini", "supportsWebSearch": false}),
        json!({"id": "a-model", "provider": "openai-api", "supportsWebSearch": true}),
    ]);
    let (catalog, probe) = catalog_of(world);
    let rows = catalog.collect(false).await.unwrap();
    assert_eq!(ids(&rows), ["default/default", "gemini/z-model", "openai/a-model"], "provider ids are normalized to their canonical name");
    assert!(probe.listed.lock().unwrap().is_empty(), "no provider was asked");
}

#[tokio::test]
async fn without_any_cache_the_quick_rows_come_from_the_live_roster_of_each_enabled_provider() {
    let mut world = main_world();
    world.rosters.insert("gemini".to_owned(), vec![searcher("gemini-2.5-flash"), plain("gemini-1.5")]);
    let (catalog, probe) = catalog_of(world);
    let rows = catalog.collect(false).await.unwrap();
    assert_eq!(ids(&rows), ["default/default", "gemini/gemini-2.5-flash"]);
    assert!(probe.listed.lock().unwrap().is_empty());
    assert!(catalog.cached().is_some(), "the quick rows are adopted");
}

#[tokio::test]
async fn in_client_mode_the_shared_catalog_is_read_each_time_and_nothing_is_adopted() {
    let mut world = main_world();
    world.client = true;
    world.collected = vec![searcher("m1"), plain("m2")]
        .into_iter()
        .map(|mut row| {
            row["provider"] = json!("openai-api");
            row
        })
        .collect();
    let (catalog, probe) = catalog_of(world);
    let rows = catalog.collect(false).await.unwrap();
    assert_eq!(ids(&rows), ["default/default", "openai/m1"]);
    catalog.collect(true).await.unwrap();
    assert_eq!(*probe.collected_with.lock().unwrap(), [false, true]);
    assert!(catalog.cached().is_none());
}
#[test]
fn the_newest_five_models_of_the_public_catalog_are_the_quick_rows() {
    let catalog = json!({
        "a": {"name": "A", "release_date": "2024-01-01"},
        "b": {"release_date": "2025-06-01"},
        "c": {"name": "C", "release_date": "2023-01-01"},
        "d": {"name": "D"},
        "e": {"name": "E", "release_date": "not a date"},
        "f": {"name": "F", "release_date": "2025-01-01"},
        "g": {"name": "G", "release_date": "2022-01-01"},
    });
    let rows = quick_web_search_models(catalog.as_object());
    let order: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(order, ["b", "f", "a", "c", "g"], "newest first, and the models without a usable date come after the dated ones");
    assert_eq!(rows[0]["display"], "b", "a model without a name is shown by its id");
    assert_eq!(rows[1], json!({"id": "f", "display": "F", "releaseDate": "2025-01-01"}));
    assert!(quick_web_search_models(None).is_empty());
}

#[test]
fn the_main_model_row_is_the_route_laid_over_the_catalog_row() {
    let route = json!({"provider": "openai-oauth", "model": "gpt-5.5", "effort": "high"});
    let meta = main_model_meta(&route, Some(&json!({"contextWindow": 400000, "effort": "low"}))).unwrap();
    assert_eq!(meta["id"], "gpt-5.5");
    assert_eq!(meta["display"], "gpt-5.5");
    assert_eq!(meta["contextWindow"], 400000);
    assert_eq!(meta["effort"], "high", "the route's own value wins");
    assert!(main_model_meta(&json!({"provider": "openai-oauth"}), None).is_none());
    assert!(main_model_meta(&json!({"model": "m"}), None).is_none());
}

#[test]
fn a_custom_providers_declared_fields_win_over_the_catalog_metadata() {
    let meta = json!({"supportsReasoning": true, "reasoningOptions": ["low", "high"], "contextWindow": 1000});
    let row = json!({"id": "m", "supportsReasoning": false, "reasoningLevels": ["x"]});
    let custom = hydrated_model("custom-acme", &row, &meta);
    assert_eq!(custom["supportsReasoning"], false);
    assert_eq!(custom["reasoningOptions"], json!([]), "levels stated without options leave no options");
    assert_eq!(custom["contextWindow"], 1000);
    let builtin = hydrated_model("openai", &json!({"id": "m"}), &meta);
    assert_eq!(builtin["supportsReasoning"], true);
    assert_eq!(builtin["reasoningOptions"], json!(["low", "high"]));
}
