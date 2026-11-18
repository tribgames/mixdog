//! The local provider lists what the managed runtime reports installed: every row, as the picker shows it, with no
//! server and no network involved.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::providers::local::listing::InstalledModels;
use mixdog_ai::providers::local::listing::LocalListing;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Value;
use serde_json::json;

struct Installed(Result<Vec<Value>, ProviderError>);

#[async_trait]
impl InstalledModels for Installed {
    async fn installed(&self) -> Result<Vec<Value>, ProviderError> {
        self.0.clone()
    }
}

fn listing(rows: Vec<Value>) -> LocalListing {
    LocalListing::new(Arc::new(Installed(Ok(rows))))
}

#[tokio::test]
async fn every_installed_row_is_listed_in_the_runtimes_order_with_its_stated_facts() {
    let rows = vec![
        json!({"id": "qwen3-8b", "display": "Qwen3 8B", "contextWindow": 32768, "supportsReasoning": true, "supportsVision": false, "mode": "chat"}),
        json!({"id": "gemma-3-4b", "display": "Gemma 3 4B", "contextWindow": 8192, "supportsReasoning": false, "supportsVision": true, "mode": "chat"}),
    ];
    let records = listing(rows.clone()).list_models().await.unwrap();
    assert_eq!(records.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["qwen3-8b", "gemma-3-4b"]);
    assert_eq!(records[0].display_name.as_deref(), Some("Qwen3 8B"));
    assert_eq!((records[0].context_window, records[0].supports_reasoning, records[0].supports_images), (Some(32768), Some(true), Some(false)));
    assert_eq!((records[1].context_window, records[1].supports_reasoning, records[1].supports_images), (Some(8192), Some(false), Some(true)));
    assert_eq!(records[1].mode.as_deref(), Some("chat"));
    // The row is kept as the runtime stated it.
    assert_eq!(records[0].raw.as_ref(), Some(&rows[0]));
}

#[tokio::test]
async fn a_row_states_only_what_the_runtime_knows_and_a_zero_window_is_unstated() {
    let records = listing(vec![json!({"id": "tiny", "contextWindow": 0})]).list_models().await.unwrap();
    assert_eq!(records[0].context_window, None);
    assert_eq!((records[0].display_name.clone(), records[0].supports_reasoning, records[0].mode.clone()), (None, None, None));
}

#[tokio::test]
async fn nothing_installed_lists_nothing_and_a_row_that_is_not_an_object_is_skipped() {
    assert!(listing(Vec::new()).list_models().await.unwrap().is_empty());
    let records = listing(vec![json!("stray"), json!({"id": "kept"}), json!(null)]).list_models().await.unwrap();
    assert_eq!(records.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["kept"]);
}

#[tokio::test]
async fn a_runtime_that_cannot_report_fails_the_listing_with_its_error() {
    let error = ProviderError::new(ErrorKind::Unknown, mixdog_core_api::domain::provider::DeliveryState::NotSent);
    let failure = LocalListing::new(Arc::new(Installed(Err(error)))).list_models().await.err().expect("the listing fails");
    assert_eq!(failure.kind, ErrorKind::Unknown);
}
