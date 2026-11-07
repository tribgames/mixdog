//! `model/list` against the Node recording (`fixtures/ai-admin/model-list-service-twin.json`,
//! `benchmarks/rust-core/recorders/record-model-list-service.mjs`): Node's real
//! `collectProviderModels` over scripted providers, and the same models as the catalog snapshot
//! the Rust service reads. Every row, in order, must be Node's.

#![allow(clippy::disallowed_methods, reason = "test setup: writes the catalog cache files on the test thread")]

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::{CatalogSnapshot, ModelSource, ModelsDevSource};
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, WireRequest};
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::{Value, json};

use super::model_list::ModelListService;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/ai-admin/model-list-service-twin.json")).unwrap()
}

pub(super) struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(
        &self,
        _: WireRequest,
        _exchange: mixdog_ai::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(
            ErrorKind::Transient,
            DeliveryState::NotSent,
        ))
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

struct Listed(Vec<mixdog_core_api::domain::provider::ModelRecord>);

#[async_trait]
impl mixdog_core_api::domain::provider::ModelListing for Listed {
    async fn list_models(&self) -> Result<Vec<mixdog_core_api::domain::provider::ModelRecord>, ProviderError> {
        Ok(self.0.clone())
    }
}

/// The service over a snapshot the providers' own listing code produced (`codex_record`): the
/// facts the picker rows read are the record's, not a recorded input.
#[tokio::test]
async fn a_snapshot_the_provider_listing_produced_reaches_the_rows() {
    let rows = [
        json!({ "slug": "gpt-5-codex", "display_name": "GPT 5.4", "description": "d54", "default_service_tier": "priority",
                "supports_reasoning_effort_updates": false, "supported_reasoning_levels": [{ "effort": "low" }, { "effort": "high" }] }),
        json!({ "slug": "gpt-6-mini", "display_name": "GPT 5.5" }),
    ];
    let records: Vec<_> = rows.iter().map(|row| mixdog_ai::providers::openai::models::codex_record(row).unwrap()).collect();
    let source = ModelSource::new(serde_json::from_value(json!("openai-oauth")).unwrap(), Arc::new(Listed(records)));
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), vec![source], metadata).await);
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": {} })).unwrap()).unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let service = ModelListService {
        catalog,
        config,
        primary_provider: Arc::new(|| "openai-oauth".to_owned()),
        unsupported: Arc::new(UnsupportedEfforts::default()),
    };
    let rows = service.rows(false, false).await;
    let row = |id: &str| rows.iter().find(|r| r["id"] == id).unwrap_or_else(|| panic!("{id} in {rows:?}"));
    let (stated, silent) = (row("gpt-5-codex"), row("gpt-6-mini"));
    assert_eq!(stated["display"], "GPT 5.4");
    assert_eq!(stated["description"], "d54");
    assert_eq!(stated["tier"], "version");
    assert_eq!(stated["defaultServiceTier"], "priority");
    // The catalog says this model takes no mid-conversation effort update; the version rule
    // alone would have allowed it.
    assert_eq!(stated["autoEffortCapable"], json!(false));
    assert_eq!(silent["autoEffortCapable"], json!(true));
}