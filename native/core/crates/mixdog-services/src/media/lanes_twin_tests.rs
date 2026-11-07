//! `fixtures/services/media-lanes-twin.json` (`record-media-lanes.mjs`): Node's model projection
//! and lane catalog over the same rows and credential states.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;

use super::catalog::CatalogFailure;
use super::catalog::Model;
use super::catalog::project_media_models;
use super::lanes::CatalogRows;
use super::lanes::LaneSources;
use super::lanes::MediaLanes;

fn twin() -> Value {
    let root = std::env::var("MIXDOG_FIXTURES_ROOT").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures").to_owned());
    serde_json::from_str(&std::fs::read_to_string(format!("{root}/services/media-lanes-twin.json")).unwrap()).unwrap()
}

fn model_json(model: &Model) -> Value {
    let mut row = json!({ "id": model.id, "label": model.label, "controls": model.controls });
    if let Some(description) = &model.description {
        row["description"] = json!(description);
    }
    if let Some(request) = &model.request_model {
        row["requestModel"] = json!(request);
    }
    row
}

#[test]
fn projections_match_nodes() {
    let twin = twin();
    let cases = twin["projections"].as_array().unwrap();
    assert_eq!(cases.len(), 10);
    for case in cases {
        let lane = case["lane"].as_str().unwrap();
        let rows = case["rows"].as_array().cloned().unwrap_or_default();
        let got = project_media_models(lane, &rows);
        let got = json!({ "image": got.image.iter().map(model_json).collect::<Vec<_>>(), "video": got.video.iter().map(model_json).collect::<Vec<_>>() });
        assert_eq!(got, case["result"], "projection of {lane}");
    }
}

struct Scenario {
    authenticated: Vec<String>,
    models: BTreeMap<String, Value>,
}

#[async_trait]
impl LaneSources for Scenario {
    async fn authenticated(&self, lane: &str) -> bool {
        self.authenticated.iter().any(|id| id == lane)
    }

    async fn models(&self, lane: &str) -> Result<CatalogRows, CatalogFailure> {
        let Some(entry) = self.models.get(lane) else { return Ok(CatalogRows::default()) };
        if let Some(error) = entry.get("error") {
            return Err(CatalogFailure { code: error["code"].as_str().map(str::to_owned), timed_out: error["name"] == "TimeoutError" });
        }
        Ok(CatalogRows { rows: entry["rows"].as_array().cloned().unwrap_or_default(), warning: entry["warning"].as_str().map(str::to_owned) })
    }
}

#[tokio::test]
async fn lane_catalogs_match_nodes() {
    let twin = twin();
    let scenarios = twin["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 11);
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let sources = Scenario {
            authenticated: scenario["authenticated"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect(),
            models: scenario["models"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        };
        let lanes = MediaLanes::new(Arc::new(sources));
        for call in scenario["calls"].as_array().unwrap() {
            let at = format!("{name} {}", call["op"]);
            if call["op"] == "list" {
                assert_eq!(Value::Array(lanes.list(None).await), call["result"], "{at}");
                continue;
            }
            let got = lanes.resolve(call["lane"].as_str().unwrap(), call["kind"].as_str().unwrap(), call["model"].as_str().unwrap()).await;
            match (got, call.get("error")) {
                (Ok(resolved), None) => {
                    let got = json!({ "lane": resolved.lane, "kind": resolved.kind, "model": resolved.model, "spec": resolved.spec });
                    assert_eq!(got, call["result"], "{at} {call}");
                }
                (Err(error), Some(want)) => {
                    assert_eq!(json!({ "message": error.message, "code": error.code, "status": error.status }), *want, "{at} {call}");
                }
                (got, want) => panic!("{at} {call}: {got:?} vs {want:?}"),
            }
        }
    }
}
