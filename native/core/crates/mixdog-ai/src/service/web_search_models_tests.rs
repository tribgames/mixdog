//! The web-search model list against Node's own factories (`record-web-search-models.mjs`): which tier
//! answers each read, the rows each asks the row builder for, the providers it scans, what it adopts
//! and when the revision drops it, over the same scripted world.

use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::*;

const GOLDEN: &str = include_str!("../../../../fixtures/web-search-models/golden.json");

#[derive(Default)]
struct Log {
    list: Vec<String>,
    refresh: Vec<String>,
    rows: Vec<Value>,
    collected: Vec<bool>,
    ready: Vec<Vec<String>>,
    prepared: usize,
    remembered: Vec<Value>,
}

struct World {
    spec: Value,
    rosters: Mutex<Map<String, Value>>,
    models_cache: Mutex<Option<Vec<Value>>>,
    collected: Mutex<Vec<Value>>,
    listings: Mutex<Map<String, Value>>,
    revision: Mutex<f64>,
    cached: Mutex<Value>,
    log: Mutex<Log>,
}

impl World {
    fn rec<T>(&self, f: impl FnOnce(&mut Log) -> T) -> T {
        f(&mut self.log.lock().unwrap())
    }
}

fn key(row: &Value) -> String {
    format!("{}\n{}", row["provider"].as_str().unwrap_or(""), row["id"].as_str().unwrap_or(""))
}

impl QuickFacts for World {
    fn route(&self) -> Value {
        self.spec["route"].clone()
    }

    fn display_providers(&self) -> Vec<(String, Value)> {
        self.spec["config"]["providers"].as_object().map_or_else(Vec::new, |m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
    }

    fn display_web_search_route(&self) -> Value {
        self.spec["config"]["webSearchRoute"].clone()
    }

    fn web_search_route_state(&self) -> Value {
        self.spec["webSearchRoute"].clone()
    }

    fn cached_models(&self, provider: &str) -> Vec<Value> {
        self.cached.lock().unwrap()[provider].as_array().cloned().unwrap_or_default()
    }

    fn models_dev(&self, _: &str) -> Option<Map<String, Value>> {
        None
    }

    fn hydrated(&self, provider: &str, model: &Value) -> Value {
        hydrated_model(provider, model, &json!({}))
    }

    fn cache_row(&self, provider: &str, model: &Value) -> Value {
        self.rec(|log| log.rows.push(json!([provider, model])));
        let table = &self.spec["rowCapable"];
        let id = model["id"].as_str().unwrap_or_default();
        let capable = table.get(format!("{provider}:{id}")).and_then(Value::as_bool).unwrap_or(model["supportsWebSearch"] == true);
        let mut row = model.as_object().unwrap().clone();
        row.insert("provider".into(), provider.into());
        row.insert("supportsWebSearch".into(), capable.into());
        Value::Object(row)
    }

    fn capable_for(&self, provider: &str, model: &Value) -> bool {
        self.spec["capable"].get(format!("{provider}:{}", model["id"].as_str().unwrap_or_default())) == Some(&Value::Bool(true))
    }

    fn main_model_meta(&self) -> Option<Value> {
        let route = self.route();
        let info = self.spec["providers"][route["provider"].as_str()?]["cachedInfo"].get(route["model"].as_str()?).filter(|v| !v.is_null());
        main_model_meta(&route, info)
    }

    fn sort(&self, mut rows: Vec<Value>) -> Vec<Value> {
        rows.sort_by_key(key);
        rows
    }
}

#[async_trait]
impl CatalogFacts for World {
    fn quick(&self) -> &dyn QuickFacts {
        self
    }

    fn client_mode(&self) -> bool {
        self.spec["client"] == true
    }

    fn revision(&self) -> f64 {
        *self.revision.lock().unwrap()
    }

    fn models_cache(&self) -> Option<Vec<Value>> {
        self.models_cache.lock().unwrap().clone()
    }

    fn from_cache_rows(&self, rows: &[Value]) -> Vec<Value> {
        let mut out: Vec<Value> = rows
            .iter()
            .filter(|row| row["provider"] != "hidden-provider")
            .map(|row| {
                let mut row = row.clone();
                row["hydrated"] = true.into();
                row
            })
            .collect();
        out.sort_by_key(key);
        out
    }

    async fn collect_provider_models(&self, force: bool) -> Vec<Value> {
        self.rec(|log| log.collected.push(force));
        self.collected.lock().unwrap().clone()
    }

    async fn prepare(&self) {
        self.rec(|log| log.prepared += 1);
    }

    fn providers_config(&self) -> Vec<(String, Value)> {
        self.display_providers()
    }

    async fn ensure_providers_ready(&self) {
        let mut names: Vec<String> = self.display_providers().into_iter().map(|(name, _)| name).collect();
        names.sort();
        self.rec(|log| log.ready.push(names));
    }

    fn can_list(&self, name: &str) -> bool {
        self.spec["providers"].get(name).is_some() && self.listings.lock().unwrap()[name]["list"] != "absent"
    }

    async fn refresh_models(&self, name: &str) -> Option<Result<Value, ()>> {
        let refresh = self.listings.lock().unwrap()[name].get("refresh")?.clone();
        self.rec(|log| log.refresh.push(name.to_owned()));
        Some(match refresh.as_str() {
            Some("throw") => Err(()),
            Some("notArray") => Ok(json!({ "not": "a list" })),
            _ => Ok(refresh),
        })
    }

    async fn list_models(&self, name: &str) -> Result<Value, ()> {
        self.rec(|log| log.list.push(name.to_owned()));
        let list = self.listings.lock().unwrap()[name].get("list").cloned().unwrap_or_else(|| json!([]));
        match list.as_str() {
            Some("throw") => Err(()),
            Some("notArray") => Ok(json!({ "not": "a list" })),
            _ => Ok(list),
        }
    }

    fn remember(&self, provider: &str, id: &str, row: &Value) {
        self.rec(|log| log.remembered.push(json!([provider, id, row])));
    }
}

fn names(trace: &Value, kind: &str) -> Vec<Value> {
    trace.as_array().unwrap().iter().filter(|t| t[0] == kind).cloned().collect()
}

#[tokio::test]
async fn the_web_search_list_is_nodes_collect() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 40);
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let mut spec = scenario["world"].clone();
        for (field, empty) in [("config", json!({ "providers": {} })), ("providers", json!({})), ("rosters", json!({})), ("capable", json!({})), ("rowCapable", json!({})), ("webSearchRoute", Value::Null)] {
            if spec.get(field).is_none() {
                spec[field] = empty;
            }
        }
        let world = World {
            rosters: Mutex::new(spec["rosters"].as_object().unwrap().clone()),
            models_cache: Mutex::new(spec["modelsCache"].as_array().cloned()),
            collected: Mutex::new(spec["collected"].as_array().cloned().unwrap_or_default()),
            listings: Mutex::new(spec["providers"].as_object().unwrap().clone()),
            revision: Mutex::new(0.0),
            cached: Mutex::new(json!({})),
            log: Mutex::default(),
            spec,
        };
        let catalog = WebSearchCatalog::new(world);
        for step in scenario["steps"].as_array().unwrap() {
            let w = &catalog.facts;
            match step["op"].as_str().unwrap() {
                "revision" => *w.revision.lock().unwrap() = step["value"].as_f64().unwrap_or(0.0),
                "modelsCache" => *w.models_cache.lock().unwrap() = step["rows"].as_array().cloned(),
                "roster" => {
                    w.rosters.lock().unwrap().insert(step["provider"].as_str().unwrap().to_owned(), step["rows"].clone());
                }
                "list" => {
                    let provider = step["provider"].as_str().unwrap();
                    w.listings.lock().unwrap()[provider]["list"] = step["rows"].clone();
                }
                "collected" => *w.collected.lock().unwrap() = step["rows"].as_array().cloned().unwrap(),
                "collect" => {
                    *w.cached.lock().unwrap() = step["cachedModels"].clone();
                    *w.log.lock().unwrap() = Log::default();
                    let force = step["force"] == true;
                    let rows = catalog.collect(force).await;
                    assert_eq!(Value::Array(rows), step["rows"], "{name}: rows (force {force})");
                    let log = w.log.lock().unwrap();
                    let trace = &step["trace"];
                    let strings = |v: &[String]| v.iter().map(|s| json!([s])).collect::<Vec<_>>();
                    let only = |kind: &str| names(trace, kind).into_iter().map(|t| json!([t[1]])).collect::<Vec<_>>();
                    assert_eq!(strings(&log.list), only("listModels"), "{name}: listings");
                    assert_eq!(strings(&log.refresh), only("refreshModels"), "{name}: refreshes");
                    assert_eq!(log.rows, names(trace, "cacheRow").into_iter().map(|t| json!([t[1], t[2]])).collect::<Vec<_>>(), "{name}: row requests");
                    assert_eq!(log.collected.len(), names(trace, "collectProviderModels").len(), "{name}: shared catalog reads");
                    assert_eq!(log.ready.iter().map(|r| json!(r)).collect::<Vec<_>>(), names(trace, "ensureProvidersReady").into_iter().map(|t| t[1].clone()).collect::<Vec<_>>(), "{name}: readiness");
                    assert_eq!(log.prepared, names(trace, "ensureFullConfig").len(), "{name}: config prepared");
                    assert_eq!(Value::Array(log.remembered.clone()), step["remembered"], "{name}: remembered");
                    drop(log);
                    let adopted = catalog.cached();
                    assert_eq!(adopted.map_or(Value::Null, Value::Array), step["cached"], "{name}: adopted rows");
                }
                other => panic!("{name}: step {other}"),
            }
        }
    }
}

#[test]
fn the_newest_quick_rows_are_nodes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["quick"].as_array().unwrap() {
        let models = case["models"].as_object();
        assert_eq!(Value::Array(quick_web_search_models(models)), case["rows"], "{}", case["name"]);
    }
}
