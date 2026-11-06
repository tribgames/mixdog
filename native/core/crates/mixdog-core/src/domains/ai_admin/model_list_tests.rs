//! `model/list` against the Node recording (`fixtures/ai-admin/model-list-service-twin.json`,
//! `benchmarks/rust-core/recorders/record-model-list-service.mjs`): Node's real
//! `collectProviderModels` over scripted providers, and the same models as the catalog snapshot
//! the Rust service reads. Every row, in order, must be Node's.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::{CatalogSnapshot, ModelsDevSource};
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, WireRequest};
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::{Value, json};

use super::model_list::ModelListService;
use crate::config::{Config, ConfigLanes};

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/ai-admin/model-list-service-twin.json")).unwrap()
}

struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

#[tokio::test]
async fn model_list_matches_node() {
    for (i, case) in twin()["cases"].as_array().unwrap().iter().enumerate() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let snapshot: CatalogSnapshot = serde_json::from_value(case["snapshot"].clone()).unwrap();
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
        let catalog = Arc::new(CatalogService::cold_start(snapshot, Vec::new(), metadata).await);
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, serde_json::to_vec(&json!({ "agent": case["config"] })).unwrap()).unwrap();
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let route = case["route"].as_str().unwrap().to_owned();
        let service = ModelListService {
            catalog,
            config,
            primary_provider: Arc::new(move || route.clone()),
            unsupported: Arc::new(UnsupportedEfforts::default()),
        };
        let (force, quick) = match case["read"].as_str().unwrap() {
            "force" => (true, false),
            "warm-quick" => (false, true),
            _ => (false, false),
        };
        let got = service.rows(force, quick).await;
        let want = case["value"].as_array().unwrap();
        let label = format!("case {i} ({})", case["read"]);
        assert_eq!(got.len(), want.len(), "{label}: row count");
        for (n, (got, want)) in got.iter().zip(want).enumerate() {
            assert_eq!(got, want, "{label}: row {n} {}", want["id"]);
        }
    }
}
