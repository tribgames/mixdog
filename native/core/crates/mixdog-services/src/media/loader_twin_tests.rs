//! `fixtures/services/media-loader-twin.json` (`record-media-loader.mjs`): Node's
//! `createMediaModelLoader` over a scripted source, an in-memory cache and a scripted clock. Every
//! load's rows, stale-catalog warning or failure, the provider requests made and the catalogs
//! saved, step by step, must equal Node's.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::catalog::CatalogFailure;
use super::loader::{CatalogCache, CatalogSource, ModelLoader, Target};

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-loader-twin.json");

fn failure(spec: &Value) -> CatalogFailure {
    CatalogFailure { code: spec["code"].as_str().map(str::to_owned), timed_out: spec["name"] == "TimeoutError" }
}

#[derive(Default)]
struct World {
    targets: BTreeMap<String, Value>,
    scripts: HashMap<String, Vec<Value>>,
    memory: HashMap<String, Vec<Value>>,
    expired: HashSet<String>,
    fetches: Vec<String>,
    saves: Vec<String>,
}

struct Scripted(Arc<Mutex<World>>);

#[async_trait]
impl CatalogSource for Scripted {
    async fn target(&self, lane: &str) -> Result<Target, CatalogFailure> {
        let world = self.0.lock().unwrap();
        let target = &world.targets[lane];
        if let Some(error) = target.get("error") {
            return Err(failure(error));
        }
        Ok(Target { key: target["key"].as_str().unwrap().to_owned(), revision: target["revision"].as_str().unwrap().to_owned(), cached: target["cache"] != false })
    }

    async fn fetch(&self, lane: &str) -> Result<Value, CatalogFailure> {
        let mut world = self.0.lock().unwrap();
        world.fetches.push(lane.to_owned());
        let next = world.scripts.get_mut(lane).unwrap().remove(0);
        if let Some(error) = next.get("error") {
            return Err(failure(error));
        }
        Ok(if next["notArray"] == true { json!({ "not": "an array" }) } else { next["rows"].clone() })
    }
}

#[async_trait]
impl CatalogCache for Scripted {
    async fn load(&self, key: &str, stale: bool) -> Option<Vec<Value>> {
        let world = self.0.lock().unwrap();
        (stale || !world.expired.contains(key)).then(|| world.memory.get(key).cloned()).flatten()
    }

    async fn save(&self, key: &str, rows: &[Value]) {
        let mut world = self.0.lock().unwrap();
        world.saves.push(key.to_owned());
        world.expired.remove(key);
        world.memory.insert(key.to_owned(), rows.to_vec());
    }
}

async fn outcome(loader: &ModelLoader, lane: &str) -> Value {
    match loader.load(lane).await {
        Ok(got) => json!({ "rows": got.rows, "warning": got.warning }),
        Err(error) => json!({ "error": { "code": error.code, "timedOut": error.timed_out } }),
    }
}

#[tokio::test]
async fn the_loader_answers_what_nodes_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let world = Arc::new(Mutex::new(World { targets: golden["targets"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect(), ..World::default() }));
    let clock = Arc::new(AtomicI64::new(golden["clock"].as_i64().unwrap()));
    let now: Arc<dyn Fn() -> i64 + Send + Sync> = {
        let clock = clock.clone();
        Arc::new(move || clock.load(Ordering::SeqCst))
    };
    let loader = ModelLoader::new(Arc::new(Scripted(world.clone())), Arc::new(Scripted(world.clone())), now);
    for (index, recorded) in golden["steps"].as_array().unwrap().iter().enumerate() {
        let step = &recorded["step"];
        let lane = step["lane"].as_str().unwrap_or_default();
        let mut got = Value::Null;
        match step["op"].as_str().unwrap() {
            "script" => {
                world.lock().unwrap().scripts.insert(lane.to_owned(), step["results"].as_array().unwrap().clone());
            }
            "load" => got = outcome(&loader, lane).await,
            "load-many" => {
                let count = step["count"].as_u64().unwrap() as usize;
                got = Value::Array(futures::future::join_all((0..count).map(|_| outcome(&loader, lane))).await);
            }
            "tick" => {
                clock.fetch_add(step["ms"].as_i64().unwrap(), Ordering::SeqCst);
            }
            "expire" => {
                world.lock().unwrap().expired.insert(step["key"].as_str().unwrap().to_owned());
            }
            "unexpire" => {
                world.lock().unwrap().expired.remove(step["key"].as_str().unwrap());
            }
            "revision" => {
                world.lock().unwrap().targets.get_mut(lane).unwrap()["revision"] = step["revision"].clone();
            }
            other => panic!("{other}"),
        }
        assert_eq!(got, recorded["result"], "step {index}: {step}");
        let world = world.lock().unwrap();
        assert_eq!(json!(world.fetches), recorded["fetches"], "step {index}: requests");
        assert_eq!(json!(world.saves), recorded["saves"], "step {index}: saves");
    }
}
